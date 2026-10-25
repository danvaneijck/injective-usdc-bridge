import { type Context, Hono } from "hono";
import { cors } from "hono/cors";
import type { Address } from "viem";
import { base58 } from "@scure/base";
import { type Network, chainByDomain, isSolanaAddress, toEvmAddress } from "injective-usdc-bridge";
import type { Store } from "./db.js";
import type { Health } from "./health.js";
import type { Logger } from "./log.js";
import { serveSite } from "./site.js";
import { toView } from "./view.js";

export interface ApiDeps {
  store: Store;
  network: Network;
  health: Health;
  bridgeReceiver?: Address;
  /** Index one source tx now and check it against Iris. */
  ingest: (srcDomain: number, txHash: string) => Promise<void>;
  /** Same, for a hash whose chain is unknown: every chain is asked for it. */
  ingestAnywhere?: (txHash: string) => Promise<void>;
  /** The built site (apps/site/dist), served beside the API when set. */
  siteDir?: string;
  log?: Logger;
}

const TX_RE = /^0x[0-9a-fA-F]{64}$/;
/** An app label on a hint; anything else is dropped, the hint still counts. */
const APP_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;
const RECENT_HINT_MS = 30_000;
/** Lookups of a hash we have not stored fan out to every chain's RPC: per client, per minute. */
const INGESTS_PER_MINUTE = 30;
/** Bound on the per-key maps below (hash debounce, per-client counts). */
const MAX_TRACKED = 10_000;

/** The client: the origin only accepts Cloudflare, which sets CF-Connecting-IP itself. */
function clientKey(c: Context): string {
  return ipKey(c.req.header("cf-connecting-ip")?.trim() || c.req.header("x-real-ip")?.trim() || "unknown");
}

/** An IPv6 client is its /64: one host holds a whole prefix and could rotate through it. IPv4 as is. */
export function ipKey(ip: string): string {
  if (!ip.includes(":")) return ip;
  const [head, tail] = ip.toLowerCase().split("::");
  const h = head ? head.split(":") : [];
  const t = tail ? tail.split(":") : [];
  const groups = tail === undefined ? h : [...h, ...Array<string>(Math.max(0, 8 - h.length - t.length)).fill("0"), ...t];
  return `${groups.slice(0, 4).map((g) => g.replace(/^0+(?=.)/, "")).join(":")}::/64`;
}

/**
 * 0x or inj1 (same 20 bytes on Injective) to lowercase 0x; a Solana wallet
 * stays base58 exactly as given (it is case-sensitive).
 */
export function normalizeAddress(input: string): string | null {
  const evm = toEvmAddress(input)?.toLowerCase();
  if (evm) return evm;
  const s = input.trim();
  return isSolanaAddress(s) ? s : null;
}

/** A pasted hash as stored: 0x hex lowercased (a missing 0x added), a Solana signature as is. */
export function normalizeTx(input: string): string | null {
  const s = input.trim();
  if (/^(0x)?[0-9a-fA-F]{64}$/.test(s)) return (s.startsWith("0x") ? s : `0x${s}`).toLowerCase();
  return isSolanaSignature(s) ? s : null;
}

function isSolanaSignature(tx: string): boolean {
  try {
    return base58.decode(tx).length === 64;
  } catch {
    return false;
  }
}

export function createApi(d: ApiDeps): Hono {
  const app = new Hono();
  const recentHints = new Map<string, number>();
  const ingests = new Map<string, { since: number; n: number }>();
  const tooMany = (c: Context) => c.json({ error: "too many lookups, try again in a minute" }, 429);

  /** True when this client may start another chain lookup this minute. */
  const mayIngest = (c: Context): boolean => {
    const now = Date.now();
    if (ingests.size >= MAX_TRACKED) ingests.clear();
    const key = clientKey(c);
    const w = ingests.get(key);
    if (!w || now - w.since >= 60_000) {
      ingests.set(key, { since: now, n: 1 });
      return true;
    }
    if (w.n >= INGESTS_PER_MINUTE) return false;
    w.n++;
    return true;
  };

  const noteHint = (key: string, now: number) => {
    if (recentHints.size >= MAX_TRACKED) {
      for (const [k, at] of recentHints) if (at <= now - RECENT_HINT_MS) recentHints.delete(k);
      if (recentHints.size >= MAX_TRACKED) recentHints.clear();
    }
    recentHints.set(key, now);
  };
  const view = (rows: Parameters<typeof toView>[0][]) => rows.map((r) => toView(r, d.network, d.bridgeReceiver));

  app.use("*", cors());

  app.get("/v1/health", (c) => {
    const h = d.health.report();
    return c.json(h, h.ok ? 200 : 503);
  });

  app.get("/v1/transfers", async (c) => {
    const txQuery = c.req.query("tx");
    if (txQuery !== undefined) {
      // Look up by hash alone, for someone who does not know (or never
      // picked) the chain it was sent from.
      const tx = normalizeTx(txQuery);
      if (!tx) return c.json({ error: "tx must be a transaction hash or a Solana signature" }, 400);
      let rows = d.store.byTxAnyDomain(tx);
      const key = `any:${tx}`;
      if (rows.length === 0 && d.ingestAnywhere && (recentHints.get(key) ?? 0) <= Date.now() - RECENT_HINT_MS) {
        if (!mayIngest(c)) return tooMany(c);
        noteHint(key, Date.now());
        await d.ingestAnywhere(tx);
        rows = d.store.byTxAnyDomain(tx);
      }
      return c.json({ transfers: view(rows), next: null });
    }
    const address = normalizeAddress(c.req.query("address") ?? "");
    if (!address) return c.json({ error: "address must be a 0x, inj1 or Solana address, or pass tx" }, 400);
    const limit = Math.min(Math.max(Number(c.req.query("limit") ?? 50) || 50, 1), 200);
    const before = c.req.query("before") ? Number(c.req.query("before")) : undefined;
    const rows = d.store.byAddress(address, limit, before);
    const last = rows.at(-1);
    return c.json({
      transfers: view(rows),
      next: rows.length === limit && last ? (last.block_time ?? Math.floor(last.first_seen / 1000)) : null,
    });
  });

  /** The stored rows for a burn, ingesting it first when needed; null when this client is over its limit. */
  const lookup = async (c: Context, domain: number, tx: string, force: boolean) => {
    let rows = d.store.byTx(domain, tx);
    const key = `${domain}:${tx}`;
    const recently = (recentHints.get(key) ?? 0) > Date.now() - RECENT_HINT_MS;
    if ((rows.length === 0 || force) && !recently) {
      if (!mayIngest(c)) return null;
      noteHint(key, Date.now());
      await d.ingest(domain, tx);
      rows = d.store.byTx(domain, tx);
    }
    return rows;
  };

  const parseTarget = (domainRaw: unknown, txRaw: unknown) => {
    const domain = Number(domainRaw);
    const tx = String(txRaw ?? "");
    const chain = chainByDomain(d.network, domain);
    if (!chain) return { error: `unknown source domain ${domainRaw}` } as const;
    if (chain.kind === "solana") {
      if (!isSolanaSignature(tx)) return { error: "txHash must be a base58 Solana signature" } as const;
      return { domain, tx } as const;
    }
    if (!TX_RE.test(tx)) return { error: "txHash must be a 32-byte hex hash" } as const;
    return { domain, tx: tx.toLowerCase() } as const;
  };

  app.get("/v1/transfers/:domain/:tx", async (c) => {
    const t = parseTarget(c.req.param("domain"), c.req.param("tx"));
    if ("error" in t) return c.json({ error: t.error }, 400);
    const rows = await lookup(c, t.domain, t.tx, false);
    if (!rows) return tooMany(c);
    if (rows.length === 0) return c.json({ error: "no Injective CCTP burn in that transaction" }, 404);
    return c.json({ transfers: view(rows) });
  });

  /** The widget posts its burn here right after signing, so tracking starts at once. */
  app.post("/v1/transfers/hint", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { sourceDomain?: unknown; txHash?: unknown; app?: unknown };
    const t = parseTarget(body.sourceDomain, body.txHash);
    if ("error" in t) return c.json({ error: t.error }, 400);
    if (typeof body.app === "string" && APP_RE.test(body.app)) d.store.noteApp(t.domain, t.tx, body.app, Date.now());
    const rows = await lookup(c, t.domain, t.tx, true);
    if (!rows) return tooMany(c);
    return c.json({ transfers: view(rows) }, rows.length ? 200 : 202);
  });

  if (d.siteDir) serveSite(app, d.siteDir);

  // The message can carry RPC or SQLite internals: log it, answer generically.
  app.onError((err, c) => {
    d.log?.error("api error", { path: c.req.path, error: err.message });
    return c.json({ error: "internal error" }, 500);
  });
  return app;
}

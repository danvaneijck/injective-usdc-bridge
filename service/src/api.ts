import { Hono } from "hono";
import { cors } from "hono/cors";
import type { Address } from "viem";
import { type Network, chainByDomain, toEvmAddress } from "injective-usdc-bridge";
import type { Store } from "./db.js";
import type { Health } from "./health.js";
import { serveSite } from "./site.js";
import { toView } from "./view.js";

export interface ApiDeps {
  store: Store;
  network: Network;
  health: Health;
  bridgeReceiver?: Address;
  /** Index one source tx now and check it against Iris. */
  ingest: (srcDomain: number, txHash: `0x${string}`) => Promise<void>;
  /** The built site (apps/site/dist), served beside the API when set. */
  siteDir?: string;
}

const TX_RE = /^0x[0-9a-fA-F]{64}$/;
const RECENT_HINT_MS = 30_000;

/** 0x or inj1 (same 20 bytes on Injective) to lowercase 0x. */
export function normalizeAddress(input: string): string | null {
  return toEvmAddress(input)?.toLowerCase() ?? null;
}

export function createApi(d: ApiDeps): Hono {
  const app = new Hono();
  const recentHints = new Map<string, number>();
  const view = (rows: Parameters<typeof toView>[0][]) => rows.map((r) => toView(r, d.network, d.bridgeReceiver));

  app.use("*", cors());

  app.get("/v1/health", (c) => {
    const h = d.health.report();
    return c.json(h, h.ok ? 200 : 503);
  });

  app.get("/v1/transfers", (c) => {
    const address = normalizeAddress(c.req.query("address") ?? "");
    if (!address) return c.json({ error: "address must be a 0x or inj1 address" }, 400);
    const limit = Math.min(Math.max(Number(c.req.query("limit") ?? 50) || 50, 1), 200);
    const before = c.req.query("before") ? Number(c.req.query("before")) : undefined;
    const rows = d.store.byAddress(address, limit, before);
    const last = rows.at(-1);
    return c.json({
      transfers: view(rows),
      next: rows.length === limit && last ? (last.block_time ?? Math.floor(last.first_seen / 1000)) : null,
    });
  });

  const lookup = async (domain: number, tx: `0x${string}`, force: boolean) => {
    let rows = d.store.byTx(domain, tx);
    const key = `${domain}:${tx.toLowerCase()}`;
    const recently = (recentHints.get(key) ?? 0) > Date.now() - RECENT_HINT_MS;
    if ((rows.length === 0 || force) && !recently) {
      recentHints.set(key, Date.now());
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
    if (chain.kind !== "evm") return { error: `${chain.name} sources are not supported yet` } as const;
    if (!TX_RE.test(tx)) return { error: "txHash must be a 32-byte hex hash" } as const;
    return { domain, tx: tx.toLowerCase() as `0x${string}` } as const;
  };

  app.get("/v1/transfers/:domain/:tx", async (c) => {
    const t = parseTarget(c.req.param("domain"), c.req.param("tx"));
    if ("error" in t) return c.json({ error: t.error }, 400);
    const rows = await lookup(t.domain, t.tx, false);
    if (rows.length === 0) return c.json({ error: "no Injective CCTP burn in that transaction" }, 404);
    return c.json({ transfers: view(rows) });
  });

  /** The widget posts its burn here right after signing, so tracking starts at once. */
  app.post("/v1/transfers/hint", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { sourceDomain?: unknown; txHash?: unknown };
    const t = parseTarget(body.sourceDomain, body.txHash);
    if ("error" in t) return c.json({ error: t.error }, 400);
    const rows = await lookup(t.domain, t.tx, true);
    return c.json({ transfers: view(rows) }, rows.length ? 200 : 202);
  });

  if (d.siteDir) serveSite(app, d.siteDir);

  app.onError((err, c) => c.json({ error: err.message.split("\n")[0] }, 500));
  return app;
}

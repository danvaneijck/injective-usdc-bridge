import { bech32 } from "@scure/base";
import { hexToBytes } from "viem";
import { describe, expect, it, vi } from "vitest";
import { CCTP_CONTRACTS, addressToBytes32 } from "injective-usdc-bridge";
import { createApi, normalizeAddress, normalizeTx } from "../src/api.js";
import { toNewTransfer } from "../src/classify.js";
import { Health } from "../src/health.js";
import { decodeDepositForBurn } from "../src/indexer.js";
import { Clock, LEGACY, RECEIVER, USER, attestedMessage, burnLog, memStore } from "./helpers.js";

const TX = `0x${"aa".repeat(32)}` as const;
const ctx = { bridgeReceiver: RECEIVER, legacyReceivers: [LEGACY] };

function setup() {
  const store = memStore();
  const clock = new Clock();
  const log = burnLog({ txHash: TX });
  store.insertTransfers(
    [toNewTransfer(decodeDepositForBurn(log)!, { srcDomain: 6, txHash: TX, logIndex: 0, blockNumber: 1n, blockTime: 1_700_000_000 }, ctx)],
    clock.t,
  );
  const health = new Health({ store, network: "mainnet", mode: "shadow", chainKeys: ["base"], now: clock.now });
  const ingest = vi.fn(async () => {});
  const app = createApi({ store, network: "mainnet", health, bridgeReceiver: RECEIVER, ingest });
  return { store, clock, app, ingest };
}

describe("API", () => {
  it("normalizes inj1 to the same 0x bytes", () => {
    const inj = bech32.encodeFromBytes("inj", hexToBytes(USER));
    expect(normalizeAddress(inj)).toBe(USER.toLowerCase());
    expect(normalizeAddress("nope")).toBeNull();
  });

  it("lists transfers by 0x or inj1", async () => {
    const { app } = setup();
    for (const a of [USER, bech32.encodeFromBytes("inj", hexToBytes(USER))]) {
      const res = await app.request(`/v1/transfers?address=${a}`);
      const body = (await res.json()) as { transfers: { phase: string; source: { name: string } }[] };
      expect(res.status).toBe(200);
      expect(body.transfers).toHaveLength(1);
      expect(body.transfers[0]).toMatchObject({ phase: "not_found", source: { name: "Base" } });
    }
  });

  it("offers a claim call once a transfer is attested but unminted", async () => {
    const { app, store, clock } = setup();
    const m = attestedMessage({ src: 6, dst: 29, nonce: `0x${"11".repeat(32)}`, mintRecipient: addressToBytes32(USER), amount: 10_000_000n });
    store.update({ src_domain: 6, tx_hash: TX, log_index: 0 }, { phase: "ready", message: m.message, attestation: m.attestation as string }, clock.t);
    const res = await app.request(`/v1/transfers/6/${TX}`);
    const body = (await res.json()) as { transfers: { claim: { chainId: number; to: string } }[] };
    expect(body.transfers[0]?.claim).toMatchObject({ chainId: 1776, to: CCTP_CONTRACTS.mainnet.messageTransmitter });
  });

  it("finds a transfer by its hash alone, asking every chain only for one it does not know", async () => {
    const { app, store, clock } = setup();
    const ingestAnywhere = vi.fn(async (tx: string) => {
      const log = burnLog({ txHash: tx as `0x${string}` });
      store.insertTransfers([toNewTransfer(decodeDepositForBurn(log)!, { srcDomain: 3, txHash: tx, logIndex: 0, blockNumber: 1n, blockTime: 1_700_000_000 }, ctx)], clock.t);
    });
    const api = createApi({ store, network: "mainnet", health: new Health({ store, network: "mainnet", mode: "shadow", chainKeys: ["base"], now: clock.now }), ingest: vi.fn(), ingestAnywhere });
    const known = await api.request(`/v1/transfers?tx=${TX.slice(2).toUpperCase()}`);
    expect(((await known.json()) as { transfers: { source: { domain: number } }[] }).transfers[0]?.source.domain).toBe(6);
    expect(ingestAnywhere).not.toHaveBeenCalled();

    const other = `0x${"cc".repeat(32)}`;
    const found = (await (await api.request(`/v1/transfers?tx=${other}`)).json()) as { transfers: { source: { domain: number; name: string } }[] };
    expect(found.transfers[0]?.source).toMatchObject({ domain: 3, name: "Arbitrum" });
    expect(ingestAnywhere).toHaveBeenCalledWith(other);

    // A miss is not retried for every request.
    const none = `0x${"dd".repeat(32)}`;
    await api.request(`/v1/transfers?tx=${none}`);
    await api.request(`/v1/transfers?tx=${none}`);
    expect(ingestAnywhere).toHaveBeenCalledTimes(2);
    expect((await api.request("/v1/transfers?tx=nope")).status).toBe(400);
  });

  it("reads a pasted hash as stored", () => {
    expect(normalizeTx(`  ${"AB".repeat(32)}`)).toBe(`0x${"ab".repeat(32)}`);
    const sig = "4Um9oKSeCbY7LkqK496dMZe3tHFC4oVsfupLVDzL85L4RGsZdMjjvbESAPhCEwgZVV1ndAXDvmFVNMKvEDS7KCUL";
    expect(normalizeTx(sig)).toBe(sig);
    expect(normalizeTx("0x1234")).toBeNull();
  });

  it("hint ingests unknown txs, and rejects bad input", async () => {
    const { app, ingest } = setup();
    const other = `0x${"bb".repeat(32)}`;
    const res = await app.request("/v1/transfers/hint", {
      method: "POST",
      body: JSON.stringify({ sourceDomain: 6, txHash: other }),
      headers: { "content-type": "application/json" },
    });
    expect(res.status).toBe(202);
    expect(ingest).toHaveBeenCalledWith(6, other);
    expect((await app.request("/v1/transfers/999/0x00")).status).toBe(400);
    expect((await app.request("/v1/transfers?address=0x123")).status).toBe(400);
  });

  it("health reports a delayed lane when Circle is slow for that source", async () => {
    const { app, store, clock } = setup();
    store.setCursor("base", 100, 104, clock.t);
    // The burn was at block_time 1_700_000_000; the clock is far later. Until
    // Iris has been asked, an old row says nothing about Circle (backfill).
    const unchecked = (await (await app.request("/v1/health")).json()) as { lanes: { status: string }[] };
    expect(unchecked.lanes[0]?.status).toBe("ok");

    store.update({ src_domain: 6, tx_hash: TX, log_index: 0 }, { checked_at: clock.t }, clock.t);
    const res = await app.request("/v1/health");
    const body = (await res.json()) as { ok: boolean; lanes: { chain: string; status: string; waiting: number }[] };
    expect(res.status).toBe(503);
    expect(body.lanes[0]).toMatchObject({ chain: "base", status: "delayed", waiting: 1 });
  });
});

describe("site", () => {
  async function siteApp() {
    const { mkdtemp, mkdir, writeFile } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = await mkdtemp(join(tmpdir(), "iub-site-"));
    await mkdir(join(dir, "assets"));
    await writeFile(join(dir, "index.html"), "<!doctype html><title>bridge</title>");
    await writeFile(join(dir, "assets", "app-abc123.js"), "console.log(1)");
    const store = memStore();
    const health = new Health({ store, network: "mainnet", mode: "shadow", chainKeys: [], now: () => 0 });
    return createApi({ store, network: "mainnet", health, ingest: async () => {}, siteDir: dir });
  }

  it("serves the page uncached with a CSP that forbids framing, and assets cached for good", async () => {
    const app = await siteApp();
    const page = await app.request("/");
    expect(page.status).toBe(200);
    expect(page.headers.get("content-type")).toMatch(/text\/html/);
    expect(page.headers.get("cache-control")).toBe("no-cache");
    expect(page.headers.get("content-security-policy")).toMatch(/frame-ancestors 'none'/);
    expect(page.headers.get("content-security-policy")).toMatch(/script-src 'self' https:\/\/static\.cloudflareinsights\.com;/);
    const asset = await app.request("/assets/app-abc123.js");
    expect(asset.headers.get("content-type")).toMatch(/javascript/);
    expect(asset.headers.get("cache-control")).toMatch(/immutable/);
  });

  it("answers deep links and escapes with the page, and leaves /v1 to the API", async () => {
    const app = await siteApp();
    const deep = await app.request(`/tx/6/${TX}`);
    expect(await deep.text()).toContain("<title>bridge</title>");
    const escape = await app.request("/../../etc/passwd");
    expect(await escape.text()).toContain("<title>bridge</title>");
    const api = await app.request("/v1/nope");
    expect(api.status).toBe(404);
    expect(await api.json()).toEqual({ error: "not found" });
    expect((await app.request("/v1/health")).headers.get("content-type")).toMatch(/json/);
  });
});

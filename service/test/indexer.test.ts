import { type PublicClient, TransactionReceiptNotFoundError } from "viem";
import { describe, expect, it } from "vitest";
import {
  FORWARD_HOOK_DATA,
  addressToBytes32,
  chainByKey,
  encodeGasDropHook,
  injective,
  type EvmChain,
} from "injective-usdc-bridge";
import { classify } from "../src/classify.js";
import { ChainIndexer, decodeDepositForBurn, ingestTx, logEndpoints } from "../src/indexer.js";
import { silentLogger } from "../src/log.js";
import { Clock, LEGACY, OTHER, RECEIVER, USER, burnLog, memStore } from "./helpers.js";

const ctx = { bridgeReceiver: RECEIVER, legacyReceivers: [LEGACY] };
const base = chainByKey("mainnet", "base") as EvmChain;

describe("classify", () => {
  const args = (over: Partial<Parameters<typeof classify>[0]>) => ({
    ...decodeDepositForBurn(burnLog({}))!,
    ...over,
  });

  it("plain deposit and forwarded withdrawal", () => {
    expect(classify(args({}), ctx)).toEqual({ kind: "plain", recipient: USER.toLowerCase() });
    expect(classify(args({ hookData: FORWARD_HOOK_DATA }), ctx).kind).toBe("forward");
  });

  it("gas drop reads the recipient from our hook", () => {
    const c = classify(
      args({
        mintRecipient: addressToBytes32(RECEIVER),
        destinationCaller: addressToBytes32(RECEIVER),
        hookData: encodeGasDropHook(OTHER, 500_000n),
      }),
      ctx,
    );
    expect(c).toEqual({ kind: "gas_drop", recipient: OTHER.toLowerCase() });
  });

  it("legacy v1 hook (address, sponsorFee, injDrop)", () => {
    const hook = `0x${"0".repeat(24)}${OTHER.slice(2).toLowerCase()}${"0".repeat(63)}1${"0".repeat(63)}2` as const;
    const c = classify(args({ destinationCaller: addressToBytes32(LEGACY), hookData: hook }), ctx);
    expect(c).toEqual({ kind: "legacy_gas_drop", recipient: OTHER.toLowerCase() });
  });

  it("someone else's pinned caller", () => {
    expect(classify(args({ destinationCaller: addressToBytes32(OTHER) }), ctx).kind).toBe("pinned_other");
  });
});

function fakeClient(opts: { head: bigint; logs: ReturnType<typeof burnLog>[]; failGetLogs?: boolean; calls?: string[] }) {
  return {
    getBlockNumber: async () => opts.head,
    getBlock: async ({ blockNumber }: { blockNumber: bigint }) => ({ timestamp: 1_700_000_000n + blockNumber }),
    getLogs: async ({ fromBlock, toBlock }: { fromBlock: bigint; toBlock: bigint }) => {
      opts.calls?.push(`${fromBlock}-${toBlock}`);
      if (opts.failGetLogs) throw new Error("boom");
      return opts.logs.filter((l) => l.blockNumber >= fromBlock && l.blockNumber <= toBlock);
    },
  } as unknown as PublicClient;
}

describe("ChainIndexer", () => {
  it("keeps only Injective-bound burns on a peer chain and advances the cursor", async () => {
    const store = memStore();
    const clock = new Clock();
    const logs = [
      burnLog({ blockNumber: 95n, destinationDomain: 29, txHash: `0x${"01".repeat(32)}` }),
      burnLog({ blockNumber: 96n, destinationDomain: 3, txHash: `0x${"02".repeat(32)}` }),
    ];
    const client = fakeClient({ head: 104n, logs });
    const ix = new ChainIndexer({
      chain: { ...base, logRpcs: [], rpcUrls: ["https://a"] },
      network: "mainnet",
      store,
      ctx,
      log: silentLogger,
      now: clock.now,
      startLookbackSec: 10, // the fake chain makes 1 block per second: 10 blocks, whatever the registry says
      clientForUrl: () => client,
      headClient: client,
    });
    const r = await ix.tick();
    expect(r).toMatchObject({ from: 90, to: 100, added: 1 });
    expect(store.cursors()[0]).toMatchObject({ start_block: 90, start_time: 1_700_000_090 });
    const [row] = store.byTx(6, `0x${"01".repeat(32)}`);
    expect(row).toMatchObject({ direction: "deposit", dst_domain: 29, kind: "plain", block_time: 1_700_000_095 });
    expect(store.byTx(6, `0x${"02".repeat(32)}`)).toHaveLength(0);
    expect(await ix.tick()).toBeNull();
  });

  it("keeps every burn on Injective", async () => {
    const store = memStore();
    const inj = injective("mainnet");
    const client = fakeClient({ head: 10n, logs: [burnLog({ blockNumber: 5n, destinationDomain: 6, hookData: FORWARD_HOOK_DATA })] });
    const ix = new ChainIndexer({
      chain: { ...inj, logRpcs: [], rpcUrls: ["https://a"] },
      network: "mainnet",
      store,
      ctx,
      log: silentLogger,
      now: new Clock().now,
      startLookbackSec: 60,
      clientForUrl: () => client,
      headClient: client,
    });
    await ix.tick();
    const [row] = store.byTx(29, `0x${"aa".repeat(32)}`);
    expect(row).toMatchObject({ direction: "withdraw", dst_domain: 6, kind: "forward" });
  });

  it("refetches the whole window from the next endpoint, chunked by its own span", async () => {
    const store = memStore();
    store.setCursor("base", 0, 0, 0);
    const callsA: string[] = [];
    const callsB: string[] = [];
    const head = fakeClient({ head: 2_504n, logs: [] });
    const a = fakeClient({ head: 2_504n, logs: [], failGetLogs: true, calls: callsA });
    const b = fakeClient({ head: 2_504n, logs: [burnLog({ blockNumber: 1_500n })], calls: callsB });
    const ix = new ChainIndexer({
      chain: { ...base, logRpcs: [{ url: "https://a", span: 5_000 }, { url: "https://b", span: 1_000 }], rpcUrls: [] },
      network: "mainnet",
      store,
      ctx,
      log: silentLogger,
      now: new Clock().now,
      startLookbackSec: 0,
      clientForUrl: (url) => (url === "https://a" ? a : b),
      headClient: head,
    });
    const r = await ix.tick();
    expect(callsA).toEqual(["1-2500"]);
    expect(callsB).toEqual(["1-1000", "1001-2000", "2001-2500"]);
    expect(r).toMatchObject({ added: 1, endpoint: "https://b" });
  });

  it("ingestTx treats a not-yet-mined hash as nothing found, not an error", async () => {
    const client = {
      getTransactionReceipt: async ({ hash }: { hash: `0x${string}` }) => {
        throw new TransactionReceiptNotFoundError({ hash });
      },
    } as unknown as PublicClient;
    const rows = await ingestTx({
      chain: base,
      network: "mainnet",
      client,
      store: memStore(),
      ctx,
      txHash: `0x${"ab".repeat(32)}`,
      now: 0,
    });
    expect(rows).toEqual([]);
  });

  it("orders log endpoints: overrides, calibrated, then plain RPCs", () => {
    const eps = logEndpoints(base, ["https://mine"]);
    expect(eps[0]).toEqual({ url: "https://mine", span: 1_000 });
    expect(eps[1]).toMatchObject({ url: "https://base-rpc.publicnode.com", span: 5_000 });
    expect(eps.filter((e) => e.url === "https://base-rpc.publicnode.com")).toHaveLength(1);
    expect(eps.at(-1)).toEqual({ url: "https://mainnet.base.org", span: 1_000 });
  });
});

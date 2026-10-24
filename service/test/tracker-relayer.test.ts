import { type Hex, type PublicClient, toFunctionSelector } from "viem";
import { describe, expect, it, vi } from "vitest";
import { CCTP_CONTRACTS, addressToBytes32, encodeGasDropHook, injective } from "injective-usdc-bridge";
import { toNewTransfer } from "../src/classify.js";
import type { Store } from "../src/db.js";
import { decodeDepositForBurn } from "../src/indexer.js";
import { silentLogger } from "../src/log.js";
import { Relayer } from "../src/relayer.js";
import { Tracker } from "../src/tracker.js";
import { Clock, LEGACY, OTHER, RECEIVER, USER, attestedMessage, burnLog, fakeIris, memStore, noLimit } from "./helpers.js";

const ctx = { bridgeReceiver: RECEIVER, legacyReceivers: [LEGACY] };
const TX = `0x${"aa".repeat(32)}` as Hex;
const NONCE = `0x${"11".repeat(32)}` as Hex;

function insertBurn(store: Store, clock: Clock, spec: Parameters<typeof burnLog>[0] = {}, src = 6) {
  const log = burnLog({ txHash: TX, ...spec });
  const args = decodeDepositForBurn(log)!;
  store.insertTransfers(
    [toNewTransfer(args, { srcDomain: src, txHash: log.transactionHash, logIndex: log.logIndex, blockNumber: log.blockNumber, blockTime: Math.floor(clock.t / 1000) }, ctx)],
    clock.t,
  );
  return args;
}

function tracker(store: Store, clock: Clock, iris: ReturnType<typeof fakeIris>, used: (d: number, n: Hex) => boolean = () => false) {
  return new Tracker({
    store,
    iris,
    irisLimiter: noLimit,
    network: "mainnet",
    isNonceUsed: async (d, n) => used(d, n),
    destinationBlock: async () => 1_000n,
    log: silentLogger,
    now: clock.now,
  });
}

describe("Tracker", () => {
  it("not_found -> attesting -> ready -> delivered, deciding delivery on chain", async () => {
    const store = memStore();
    const clock = new Clock();
    insertBurn(store, clock);
    const byTx: Record<string, ReturnType<typeof attestedMessage>[]> = {};
    let minted = false;
    const t = tracker(store, clock, fakeIris(byTx), () => minted);

    await t.tick();
    expect(store.byTx(6, TX)[0]?.phase).toBe("not_found");

    byTx[TX] = [{ ...attestedMessage({ src: 6, dst: 29, nonce: NONCE, mintRecipient: addressToBytes32(USER), amount: 10_000_000n }), status: "pending_confirmations", message: "0x", attestation: "PENDING" }];
    clock.advance(60_000);
    await t.tick();
    expect(store.byTx(6, TX)[0]?.phase).toBe("attesting");

    byTx[TX] = [attestedMessage({ src: 6, dst: 29, nonce: NONCE, mintRecipient: addressToBytes32(USER), amount: 10_000_000n })];
    clock.advance(25 * 60_000);
    await t.tick();
    const ready = store.byTx(6, TX)[0]!;
    expect(ready.phase).toBe("ready");
    expect(ready.event_nonce).toBe(NONCE);

    minted = true;
    clock.advance(10_000);
    await t.tick();
    expect(store.byTx(6, TX)[0]).toMatchObject({ phase: "delivered", minted_by: "unknown" });
  });

  it("dates a delivery only when it saw it arrive", async () => {
    const attested = { [TX]: [attestedMessage({ src: 6, dst: 29, nonce: NONCE, mintRecipient: addressToBytes32(USER), amount: 10_000_000n })] };
    const deliveredAt = async (setup: (store: Store, clock: Clock, t: Tracker) => Promise<void>) => {
      const store = memStore();
      const clock = new Clock();
      insertBurn(store, clock);
      await setup(store, clock, tracker(store, clock, fakeIris(attested), () => true));
      return { at: store.byTx(6, TX)[0]!.delivered_at, now: clock.t };
    };
    // Fresh: found delivered seconds after the burn, so "now" is close enough.
    const fresh = await deliveredAt(async (_s, clock, t) => {
      clock.advance(30_000);
      await t.tick();
    });
    expect(fresh.at).toBe(fresh.now);
    // First met hours later, already delivered: the time is unknown.
    const late = await deliveredAt(async (_s, clock, t) => {
      clock.advance(2 * 3_600_000);
      await t.tick();
    });
    expect(late.at).toBeNull();
    // Checked before and undelivered then: it arrived since.
    const watched = await deliveredAt(async (store, clock) => {
      await tracker(store, clock, fakeIris({}), () => false).tick();
      clock.advance(2 * 3_600_000);
      await tracker(store, clock, fakeIris(attested), () => true).tick();
    });
    expect(watched.at).toBe(watched.now);
  });

  it("runs one check per transaction even when a lookup and the loop ask together", async () => {
    const store = memStore();
    const clock = new Clock();
    insertBurn(store, clock);
    clock.advance(2 * 3_600_000);
    const calls: string[] = [];
    const attested = { [TX]: [attestedMessage({ src: 6, dst: 29, nonce: NONCE, mintRecipient: addressToBytes32(USER), amount: 10_000_000n })] };
    const t = tracker(store, clock, fakeIris(attested, calls), () => true);
    await Promise.all([t.checkTx(6, TX), t.tick()]);
    expect(calls).toEqual([`get:${TX}`]);
    // First met delivered two hours on: the second caller must not date it "now".
    expect(store.byTx(6, TX)[0]).toMatchObject({ phase: "delivered", delivered_at: null });
  });

  it("finds the mint nobody reported, searching only since it last saw the transfer undelivered", async () => {
    const store = memStore();
    const clock = new Clock();
    insertBurn(store, clock, { destinationDomain: 3 }, 29);
    const attested = { [TX]: [attestedMessage({ src: 29, dst: 3, nonce: NONCE, mintRecipient: addressToBytes32(USER), amount: 10_000_000n })] };
    const claim = `0x${"c1".repeat(32)}`;
    const searches: { dst: number; nonce: string; since: number }[] = [];
    let minted = false;
    const t = new Tracker({
      store,
      iris: fakeIris(attested),
      irisLimiter: noLimit,
      network: "mainnet",
      isNonceUsed: async () => minted,
      destinationBlock: async () => 0n,
      txTime: async (_d, hash) => (hash === claim ? clock.t - 20_000 : null),
      findMintTx: async (dst, nonce, since) => {
        searches.push({ dst, nonce, since });
        return claim;
      },
      log: silentLogger,
      now: clock.now,
    });
    clock.advance(60_000);
    await t.tick();
    const lastCheck = clock.t;
    expect(store.byTx(29, TX)[0]?.phase).toBe("ready");

    // Claimed by its owner hours later: no forward tx, not our relayer.
    minted = true;
    clock.advance(3 * 3_600_000);
    await t.checkTx(29, TX);
    expect(searches).toEqual([{ dst: 3, nonce: NONCE, since: lastCheck }]);
    expect(store.byTx(29, TX)[0]).toMatchObject({ phase: "delivered", mint_tx: claim, delivered_at: clock.t - 20_000 });
  });

  it("does not search for a mint it never watched for", async () => {
    const store = memStore();
    const clock = new Clock();
    insertBurn(store, clock);
    const findMintTx = vi.fn(async () => null);
    const t = new Tracker({
      store,
      iris: fakeIris({ [TX]: [attestedMessage({ src: 6, dst: 29, nonce: NONCE, mintRecipient: addressToBytes32(USER), amount: 10_000_000n })] }),
      irisLimiter: noLimit,
      network: "mainnet",
      isNonceUsed: async () => true,
      destinationBlock: async () => 0n,
      findMintTx,
      log: silentLogger,
      now: clock.now,
    });
    clock.advance(2 * 3_600_000);
    await t.tick();
    expect(findMintTx).not.toHaveBeenCalled();
    expect(store.byTx(6, TX)[0]).toMatchObject({ phase: "delivered", mint_tx: null, delivered_at: null });
  });

  it("pairs several burns in one tx with their own messages", async () => {
    const store = memStore();
    const clock = new Clock();
    insertBurn(store, clock, { amount: 1_000_000n, logIndex: 0 });
    insertBurn(store, clock, { amount: 2_000_000n, logIndex: 1 });
    const n1 = `0x${"01".repeat(32)}` as Hex;
    const n2 = `0x${"02".repeat(32)}` as Hex;
    const iris = fakeIris({
      [TX]: [
        attestedMessage({ src: 6, dst: 29, nonce: n2, mintRecipient: addressToBytes32(USER), amount: 2_000_000n }),
        attestedMessage({ src: 6, dst: 29, nonce: n1, mintRecipient: addressToBytes32(USER), amount: 1_000_000n }),
      ],
    });
    await tracker(store, clock, iris).tick();
    const rows = store.byTx(6, TX);
    expect(rows.map((r) => r.event_nonce)).toEqual([n1, n2]);
  });

  it("forwarded withdrawal records Circle's mint tx", async () => {
    const store = memStore();
    const clock = new Clock();
    insertBurn(store, clock, { destinationDomain: 6 }, 29);
    const fwd = "0xcb42b1f0343747c92ce61cc2733f73206a70600857de2d3381cf907cd460b862";
    const iris = fakeIris({
      [TX]: [{ ...attestedMessage({ src: 29, dst: 6, nonce: NONCE, mintRecipient: addressToBytes32(USER), amount: 10_000_000n }), forwardState: "CONFIRMED", forwardTxHash: fwd }],
    });
    const t = new Tracker({
      store,
      iris,
      irisLimiter: noLimit,
      network: "mainnet",
      isNonceUsed: async () => true,
      destinationBlock: async () => 0n,
      txTime: async (_d, hash) => (hash === fwd ? 1_760_607_931_000 : null),
      log: silentLogger,
      now: clock.now,
    });
    await t.tick();
    expect(store.byTx(29, TX)[0]).toMatchObject({
      phase: "delivered",
      minted_by: "circle",
      mint_tx: fwd,
      forward_state: "CONFIRMED",
      delivered_at: 1_760_607_931_000, // the mint's block time, not when we noticed
    });
  });

  it("expired messages trigger one reattest", async () => {
    const store = memStore();
    const clock = new Clock();
    insertBurn(store, clock);
    const calls: string[] = [];
    const iris = fakeIris(
      { [TX]: [attestedMessage({ src: 6, dst: 29, nonce: NONCE, mintRecipient: addressToBytes32(USER), amount: 10_000_000n, expirationBlock: 500n })] },
      calls,
    );
    const t = tracker(store, clock, iris);
    await t.tick();
    clock.advance(31_000);
    await t.tick();
    expect(store.byTx(6, TX)[0]?.phase).toBe("expired");
    expect(calls.filter((c) => c.startsWith("reattest"))).toEqual([`reattest:${NONCE}`]);
  });
});

function fakeInjClient(opts: { simulateFails?: boolean; calls: unknown[] }) {
  return {
    call: async (a: unknown) => {
      opts.calls.push(["call", a]);
      if (opts.simulateFails) throw new Error("execution reverted: Nonce already used");
    },
    estimateGas: async () => 200_000n,
    getBlock: async () => ({ baseFeePerGas: 160_000_000n }),
    estimateMaxPriorityFeePerGas: async () => 0n,
    waitForTransactionReceipt: async () => ({ status: "success", gasUsed: 180_000n }),
  } as unknown as PublicClient;
}

async function readyRow(store: Store, clock: Clock, spec: Parameters<typeof burnLog>[0], used = () => false) {
  const args = insertBurn(store, clock, spec);
  const msg = attestedMessage({
    src: 6,
    dst: 29,
    nonce: NONCE,
    mintRecipient: args.mintRecipient,
    amount: args.amount,
    destinationCaller: args.destinationCaller,
    hookData: args.hookData,
  });
  await tracker(store, clock, fakeIris({ [TX]: [msg] }), used).tick();
  expect(store.byTx(6, TX)[0]?.phase).toBe("ready");
}

function relayer(
  store: Store,
  clock: Clock,
  opts: { mode?: "shadow" | "relay"; simulateFails?: boolean; used?: () => boolean; minRelayPlain?: bigint } = {},
) {
  const calls: unknown[] = [];
  const sent: { to: string; data: string }[] = [];
  const wallet = {
    account: { address: USER },
    sendTransaction: vi.fn(async (tx: { to: string; data: string }) => {
      sent.push(tx);
      return `0x${"cd".repeat(32)}`;
    }),
  };
  const r = new Relayer({
    store,
    network: "mainnet",
    mode: opts.mode ?? "relay",
    injective: injective("mainnet"),
    client: fakeInjClient({ simulateFails: opts.simulateFails, calls }),
    wallet: wallet as never,
    bridgeReceiver: RECEIVER,
    depositGraceSec: 15,
    legacyGraceSec: 120,
    minRelayPlain: opts.minRelayPlain,
    isNonceUsed: async () => opts.used?.() ?? false,
    log: silentLogger,
    now: clock.now,
  });
  return { r, sent, calls };
}

describe("Relayer", () => {
  it("waits out the grace period, then mints a plain deposit via MessageTransmitter", async () => {
    const store = memStore();
    const clock = new Clock();
    await readyRow(store, clock, {});
    const { r, sent } = relayer(store, clock);
    await r.tick();
    expect(sent).toHaveLength(0);
    clock.advance(16_000);
    await r.tick();
    expect(sent[0]?.to).toBe(CCTP_CONTRACTS.mainnet.messageTransmitter);
    expect(store.byTx(6, TX)[0]).toMatchObject({ phase: "delivered", minted_by: "relayer", mint_tx: `0x${"cd".repeat(32)}` });
  });

  it("leaves a plain deposit under the relay floor for the depositor to mint", async () => {
    const store = memStore();
    const clock = new Clock();
    await readyRow(store, clock, { amount: 1n });
    const { r, sent } = relayer(store, clock, { minRelayPlain: 100_000n });
    clock.advance(16_000);
    expect(await r.tick()).toBe(0);
    clock.advance(3_600_000);
    await r.tick();
    expect(sent).toHaveLength(0);
    expect(store.byTx(6, TX)[0]).toMatchObject({ phase: "ready", last_error: "below the relay floor: left for self-mint" });
  });

  it("gas-drop deposits go through BridgeReceiver; v1 ones through their v1 receiver", async () => {
    const store = memStore();
    const clock = new Clock();
    await readyRow(store, clock, {
      mintRecipient: addressToBytes32(RECEIVER),
      destinationCaller: addressToBytes32(RECEIVER),
      hookData: encodeGasDropHook(OTHER, 500_000n),
    });
    const { r, sent } = relayer(store, clock);
    clock.advance(16_000);
    await r.tick();
    expect(sent[0]?.to).toBe(RECEIVER);
    expect(sent[0]?.data.slice(0, 10)).toBe(toFunctionSelector("relay(bytes,bytes)"));

    const store2 = memStore();
    await readyRow(store2, clock, { destinationCaller: addressToBytes32(LEGACY) });
    const v1 = relayer(store2, clock);
    clock.advance(30_000);
    await v1.r.tick();
    expect(v1.sent).toHaveLength(0); // legacy grace is 120 s: v1's own backend goes first
    clock.advance(120_000);
    await v1.r.tick();
    expect(v1.sent[0]?.to).toBe(LEGACY);
  });

  it("shadow mode never sends", async () => {
    const store = memStore();
    const clock = new Clock();
    await readyRow(store, clock, {});
    const { r, sent } = relayer(store, clock, { mode: "shadow" });
    clock.advance(16_000);
    await r.tick();
    expect(sent).toHaveLength(0);
    expect(store.byTx(6, TX)[0]).toMatchObject({ phase: "ready", last_error: "shadow: would relay" });
  });

  it("a failed simulation after someone else's mint counts as delivered, not an error", async () => {
    const store = memStore();
    const clock = new Clock();
    await readyRow(store, clock, {});
    let used = false;
    const { r, sent } = relayer(store, clock, {
      simulateFails: true,
      used: () => {
        const v = used;
        used = true; // first read: not yet; second (after the revert): minted
        return v;
      },
    });
    clock.advance(16_000);
    await r.tick();
    expect(sent).toHaveLength(0);
    expect(store.byTx(6, TX)[0]).toMatchObject({ phase: "delivered", relay_attempts: 0 });
  });

  it("a real simulation failure backs off and counts the attempt", async () => {
    const store = memStore();
    const clock = new Clock();
    await readyRow(store, clock, {});
    const { r } = relayer(store, clock, { simulateFails: true });
    clock.advance(16_000);
    await r.tick();
    const row = store.byTx(6, TX)[0]!;
    expect(row).toMatchObject({ phase: "ready", relay_attempts: 1 });
    expect(row.next_relay_at).toBe(clock.t + 30_000);
  });

  it("never relays someone else's pinned burn", async () => {
    const store = memStore();
    const clock = new Clock();
    await readyRow(store, clock, { destinationCaller: addressToBytes32(OTHER) });
    const { r, sent } = relayer(store, clock);
    clock.advance(600_000);
    await r.tick();
    expect(sent).toHaveLength(0);
  });
});

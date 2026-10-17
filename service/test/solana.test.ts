import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  FORWARD_HOOK_DATA,
  ZERO_BYTES32,
  associatedTokenAddress,
  chainByKey,
  forwardHookDataWithAccountSetup,
  remoteTokenMessengerAddress,
  type SolanaChain,
  solanaToBytes32,
} from "injective-usdc-bridge";
import { createApi, normalizeAddress } from "../src/api.js";
import { classify, toNewTransfer } from "../src/classify.js";
import { Store } from "../src/db.js";
import { Health } from "../src/health.js";
import { createLogger } from "../src/log.js";
import { SolanaIndexer, burnsInTransaction } from "../src/solanaIndexer.js";
import { Clock, LEGACY, RECEIVER, memStore } from "./helpers.js";

const solana = chainByKey("mainnet", "solana") as SolanaChain;
const ctx = { bridgeReceiver: RECEIVER, legacyReceivers: [LEGACY] };
const log = createLogger("error", {});
/** Real mainnet burn, Solana -> Injective, 2 USDC (slot 457551948). */
const BURN = JSON.parse(readFileSync(new URL("./fixtures/solana-burn-to-injective.json", import.meta.url), "utf8"));
const OWNER = "CeeVcSmNej5z8zKaaoX4TUG1su7i3vPHut52vViNdeBi";
/** The burn's MessageSent account, holding the rent the owner can reclaim. */
const EVENT = "2F5eMVcS3XsYZqjtkfDnbc7AxMzPzZdR2TSAj16goBZp";
const RECEIVE_SIG = "j5rdVVVu6GW8bZU9M1gLweGEHXQuhxHMgXYWSmV8T3f4aKABio3RXn8fzSPNi42GUmWAiDCGY75udRdRiAggRQE";

/** A Solana RPC that knows two signatures on the watched account: one burn, one mint from Injective. */
function fakeRpc(opts: { slot: number; burnReadable?: boolean }) {
  const calls: { method: string; params: unknown[] }[] = [];
  const fetchImpl = (async (_url: string, init: { body: string }) => {
    const { method, params } = JSON.parse(init.body) as { method: string; params: unknown[] };
    calls.push({ method, params });
    let result: unknown = null;
    if (method === "getSlot") result = opts.slot;
    if (method === "getSignaturesForAddress") {
      result = [
        { signature: RECEIVE_SIG, slot: BURN.slot + 100, err: null, blockTime: BURN.blockTime + 40 },
        { signature: BURN.signature, slot: BURN.slot, err: null, blockTime: BURN.blockTime },
      ];
    }
    if (method === "getTransaction") {
      const sig = params[0];
      if (sig === BURN.signature) result = opts.burnReadable === false ? null : BURN;
      if (sig === RECEIVE_SIG) {
        result = {
          slot: BURN.slot + 100,
          blockTime: BURN.blockTime + 40,
          meta: { err: null, logMessages: ["Program log: Instruction: ReceiveMessage"] },
          transaction: { message: { accountKeys: [], instructions: [] } },
        };
      }
    }
    return new Response(JSON.stringify({ result }));
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

function indexer(fetchImpl: typeof fetch, store = memStore(), clock = new Clock()) {
  return {
    store,
    clock,
    ix: new SolanaIndexer({ chain: solana, store, ctx, log, now: clock.now, startLookbackSec: 6 * 3600, rpcUrls: ["x"], fetchImpl }),
  };
}

describe("Solana indexer", () => {
  it("decodes a real burn to Injective out of its transaction", () => {
    const burns = burnsInTransaction(BURN);
    expect(burns).toHaveLength(1);
    expect(burns[0]).toMatchObject({
      owner: OWNER,
      eventAccount: EVENT,
      burn: { amount: 2_000_000n, destinationDomain: 29, destinationCaller: ZERO_BYTES32 },
    });
  });

  it("indexes burns from the watched account and skips mints from Injective", async () => {
    const { fetchImpl, calls } = fakeRpc({ slot: BURN.slot + 200 });
    const { ix, store } = indexer(fetchImpl);
    store.setCursorStart("solana", BURN.slot - 10, BURN.blockTime - 10, 0);
    const r = await ix.tick();
    expect(r).toEqual({ added: 1, signatures: 2 });
    const [row] = store.byTx(5, BURN.signature);
    expect(row).toMatchObject({
      tx_hash: BURN.signature, // base58 keeps its case
      direction: "deposit",
      dst_domain: 29,
      depositor: OWNER,
      kind: "plain",
      recipient: "0x21eb63b81d92ca293470e643a124607e4ff1ce60",
      amount: "2000000",
      block_number: BURN.slot,
      event_account: EVENT,
    });
    expect(calls.find((c) => c.method === "getSignaturesForAddress")!.params[0]).toBe(remoteTokenMessengerAddress(29));
    // The cursor trails the head by a small margin; a second round re-reads nothing.
    expect(store.getCursor("solana")).toBe(BURN.slot + 200 - 50);
    const before = calls.filter((c) => c.method === "getTransaction").length;
    await ix.tick();
    expect(calls.filter((c) => c.method === "getTransaction").length).toBe(before);
  });

  it("never steps its cursor past a burn it could not read", async () => {
    const { fetchImpl } = fakeRpc({ slot: BURN.slot + 200, burnReadable: false });
    const { ix, store } = indexer(fetchImpl);
    store.setCursorStart("solana", BURN.slot - 10, BURN.blockTime - 10, 0);
    await ix.tick();
    expect(store.byTx(5, BURN.signature)).toHaveLength(0);
    expect(store.getCursor("solana")).toBe(BURN.slot - 1);
  });

  it("adds the event-account column to a database made before it existed", () => {
    const path = join(mkdtempSync(join(tmpdir(), "iub-")), "bridge.db");
    const old = new Store(path);
    old.db.exec("ALTER TABLE transfers DROP COLUMN event_account");
    old.close();
    const store = new Store(path);
    const [b] = burnsInTransaction(BURN);
    store.insertTransfers([{ ...toNewTransfer({ ...b!.burn, depositor: b!.owner }, { srcDomain: 5, txHash: BURN.signature, logIndex: 0, blockNumber: 1n, blockTime: 1 }, ctx), event_account: EVENT }], 1);
    expect(store.byTx(5, BURN.signature)[0]!.event_account).toBe(EVENT);
    store.close();
  });

  it("forgets delivery dates that were only the moment an old transfer was noticed, once", () => {
    const path = join(mkdtempSync(join(tmpdir(), "iub-")), "bridge.db");
    const burn = 1_792_000_000;
    const seen = (burn + 7 * 86_400) * 1000; // looked up a week after the burn
    const old = new Store(path);
    const [b] = burnsInTransaction(BURN);
    const rows = [0, 1].map((logIndex) =>
      toNewTransfer({ ...b!.burn, depositor: b!.owner }, { srcDomain: 5, txHash: BURN.signature, logIndex, blockNumber: 1n, blockTime: burn }, ctx),
    );
    old.insertTransfers(rows, seen);
    old.update(rows[0]!, { phase: "delivered", delivered_at: seen + 5_000, minted_by: "unknown" }, seen);
    old.update(rows[1]!, { phase: "delivered", delivered_at: seen + 5_000, minted_by: "relayer" }, seen);
    old.db.prepare("DELETE FROM meta").run(); // as a database from before the fix
    old.close();

    const store = new Store(path);
    expect(store.get(5, BURN.signature, 0)!.delivered_at).toBeNull();
    expect(store.get(5, BURN.signature, 1)!.delivered_at).toBe(seen + 5_000); // our relayer's own mint time stands
    store.update(rows[0]!, { delivered_at: 123 }, seen);
    store.close();
    expect(new Store(path).get(5, BURN.signature, 0)!.delivered_at).toBe(123); // the fix ran once
  });

  it("starts from the lookback, not from the beginning of Solana", async () => {
    const { fetchImpl } = fakeRpc({ slot: 500_000_000 });
    const { ix, store } = indexer(fetchImpl);
    await ix.tick();
    const start = store.cursors().find((c) => c.chain_key === "solana")!.start_block!;
    expect(start).toBe(500_000_000 - (6 * 3600 * 1000) / 400);
  });
});

describe("withdrawals to Solana", () => {
  const owner = OWNER;
  const ata = associatedTokenAddress(owner, solana.usdcMint);
  const base = {
    amount: 1_000_000n,
    depositor: "0x73fcb2d05f2e29561b58177af7f22ac19b3b484f",
    mintRecipient: solanaToBytes32(ata),
    destinationDomain: 5,
    destinationCaller: ZERO_BYTES32,
    maxFee: 130_000n,
    minFinalityThreshold: 2000,
  };

  it("knows the wallet when Circle was asked to create its USDC account", () => {
    expect(classify({ ...base, hookData: forwardHookDataWithAccountSetup(solanaToBytes32(owner)) }, ctx)).toEqual({ kind: "forward", recipient: owner });
  });

  it("leaves the wallet to be looked up when the account already existed", () => {
    expect(classify({ ...base, hookData: FORWARD_HOOK_DATA }, ctx)).toEqual({ kind: "forward", recipient: null });
  });
});

describe("API with Solana", () => {
  function setup() {
    const store = memStore();
    const clock = new Clock();
    const [b] = burnsInTransaction(BURN);
    store.insertTransfers(
      [
        {
          ...toNewTransfer({ ...b!.burn, depositor: b!.owner }, { srcDomain: 5, txHash: BURN.signature, logIndex: 0, blockNumber: BigInt(BURN.slot), blockTime: BURN.blockTime }, ctx),
          event_account: b!.eventAccount,
        },
      ],
      clock.t,
    );
    const health = new Health({ store, network: "mainnet", mode: "shadow", chainKeys: ["solana"], now: clock.now });
    const ingest = vi.fn(async () => {});
    return { app: createApi({ store, network: "mainnet", health, bridgeReceiver: RECEIVER, ingest }), ingest, store };
  }

  it("looks transfers up by Solana signature, case intact, with a Solscan link", async () => {
    const { app } = setup();
    const res = await app.request(`/v1/transfers/5/${BURN.signature}`);
    expect(res.status).toBe(200);
    const { transfers } = (await res.json()) as { transfers: { source: { txHash: string; txUrl: string; name: string } }[] };
    expect(transfers[0]!.source).toMatchObject({ txHash: BURN.signature, name: "Solana", txUrl: `https://solscan.io/tx/${BURN.signature}` });
  });

  it("lists a Solana wallet's transfers and rejects hex hashes for Solana", async () => {
    const { app } = setup();
    expect(normalizeAddress(OWNER)).toBe(OWNER);
    const res = await app.request(`/v1/transfers?address=${OWNER}`);
    expect(((await res.json()) as { transfers: unknown[] }).transfers).toHaveLength(1);
    expect((await app.request(`/v1/transfers/5/0x${"aa".repeat(32)}`)).status).toBe(400);
  });

  it("offers the deposit's rent back from 5 days after the burn, once attested", async () => {
    const { app, store } = setup();
    const view = async () =>
      ((await (await app.request(`/v1/transfers/5/${BURN.signature}`)).json()) as { transfers: { solanaRefund: unknown; solanaClaim: unknown }[] })
        .transfers[0]!;
    expect((await view()).solanaRefund).toBeNull(); // no attestation yet
    store.update({ src_domain: 5, tx_hash: BURN.signature, log_index: 0 }, { phase: "delivered", message: "0x01", attestation: "0x02" }, 1);
    expect((await view()).solanaRefund).toEqual({
      eventAccount: EVENT,
      message: "0x01",
      attestation: "0x02",
      availableAt: new Date((BURN.blockTime + 5 * 86_400) * 1000).toISOString(),
    });
    expect((await view()).solanaClaim).toBeNull(); // only for transfers to Solana
  });

  it("hands a Solana wallet what it needs to claim an undelivered transfer to Solana", async () => {
    const { app, store } = setup();
    const ata = associatedTokenAddress(OWNER, solana.usdcMint);
    const hash = `0x${"cd".repeat(32)}`;
    store.insertTransfers(
      [
        toNewTransfer(
          { amount: 1_000_000n, depositor: "0x73fcb2d05f2e29561b58177af7f22ac19b3b484f", mintRecipient: solanaToBytes32(ata), destinationDomain: 5, destinationCaller: ZERO_BYTES32, maxFee: 0n, minFinalityThreshold: 2000, hookData: "0x" },
          { srcDomain: 29, txHash: hash, logIndex: 0, blockNumber: 1n, blockTime: 1 },
          ctx,
        ),
      ],
      1,
    );
    store.update({ src_domain: 29, tx_hash: hash, log_index: 0 }, { phase: "ready", message: "0x0a", attestation: "0x0b" }, 1);
    const { transfers } = (await (await app.request(`/v1/transfers/29/${hash}`)).json()) as { transfers: { claim: unknown; solanaClaim: unknown; solanaRefund: unknown }[] };
    expect(transfers[0]).toMatchObject({ claim: null, solanaClaim: { message: "0x0a", attestation: "0x0b" }, solanaRefund: null });
  });

  it("passes a hinted Solana signature to the indexer unchanged", async () => {
    const { app, ingest } = setup();
    const sig = RECEIVE_SIG;
    await app.request("/v1/transfers/hint", { method: "POST", body: JSON.stringify({ sourceDomain: 5, txHash: sig }), headers: { "content-type": "application/json" } });
    expect(ingest).toHaveBeenCalledWith(5, sig);
  });
});

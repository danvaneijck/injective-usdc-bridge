import { base58 } from "@scure/base";
import type { Hex } from "viem";
import {
  INJECTIVE_DOMAIN,
  type IrisClient,
  SOLANA_BURN_ACCOUNTS,
  bytes32ToSolana,
  decodeBurnMessage,
  decodeMessage,
  SOLANA_TOKEN_MESSENGER_MINTER_V2,
  type SolanaChain,
  decodeSolanaBurn,
  remoteTokenMessengerAddress,
  solanaRpc,
} from "injective-usdc-bridge";
import { type ClassifyContext, toNewTransfer } from "./classify.js";
import type { NewTransfer, Store } from "./db.js";
import type { Logger } from "./log.js";

/** Solana slots are ~400 ms. */
const SLOT_MS = 400;
/**
 * The cursor stays this far behind the slot read at the start of a round, so
 * a signature confirmed a moment after that read is still picked up next
 * round (about 20 s; seen signatures are remembered, so it costs nothing).
 */
const CURSOR_MARGIN_SLOTS = 50;
const PAGE = 1_000;

interface SignatureInfo {
  signature: string;
  slot: number;
  err: unknown;
  blockTime: number | null;
}

interface JsonInstruction {
  programIdIndex: number;
  accounts: number[];
  data: string;
}

interface JsonTransaction {
  slot: number;
  blockTime: number | null;
  meta: {
    err: unknown;
    loadedAddresses?: { writable: string[]; readonly: string[] };
    innerInstructions?: { index: number; instructions: JsonInstruction[] }[];
    logMessages?: string[];
  } | null;
  transaction: { message: { accountKeys: string[]; instructions: JsonInstruction[] } };
}

export interface SolanaIndexerOptions {
  chain: SolanaChain;
  store: Store;
  ctx: ClassifyContext;
  log: Logger;
  now: () => number;
  startLookbackSec: number;
  rpcUrls?: readonly string[];
  fetchImpl?: typeof fetch;
  /** Fallback decoder for a transaction whose layout this code does not know. */
  iris?: IrisClient;
}

/**
 * Every Solana burn bound for Injective lists TokenMessengerMinter's
 * remote_token_messenger account for domain 29, so its signature history is a
 * complete, small index of them (mints from Injective list it too and are
 * skipped). Each burn is decoded from its own instruction data, so indexing
 * does not wait on Circle.
 */
export class SolanaIndexer {
  readonly chain: SolanaChain;
  readonly watched = remoteTokenMessengerAddress(INJECTIVE_DOMAIN);
  /** Public RPC history for the account is ~14 h deep; a few calls a poll. */
  readonly idleMs = 15_000;
  private readonly rpcUrls: readonly string[];
  private readonly seen = new Set<string>();

  constructor(private readonly o: SolanaIndexerOptions) {
    this.chain = o.chain;
    this.rpcUrls = o.rpcUrls?.length ? o.rpcUrls : o.chain.rpcUrls;
  }

  private rpc<T>(method: string, params: unknown[]): Promise<T> {
    return solanaRpc<T>(this.rpcUrls, method, params, this.o.fetchImpl);
  }

  async tick(): Promise<{ added: number; signatures: number } | null> {
    const head = await this.rpc<number>("getSlot", [{ commitment: "confirmed" }]);
    let cursor = this.o.store.getCursor(this.chain.key);
    if (cursor === undefined) {
      const lookback = Math.ceil((this.o.startLookbackSec * 1000) / SLOT_MS);
      const start = Math.max(1, head - lookback);
      this.o.store.setCursorStart(this.chain.key, start, Math.floor(this.o.now() / 1000) - this.o.startLookbackSec, this.o.now());
      this.o.log.info("cursor initialised", { chain: this.chain.key, startSlot: start });
      cursor = start - 1;
    }

    // Newest first, back to the cursor.
    const fresh: SignatureInfo[] = [];
    let before: string | undefined;
    for (;;) {
      const page = await this.rpc<SignatureInfo[]>("getSignaturesForAddress", [
        this.watched,
        { limit: PAGE, commitment: "confirmed", ...(before ? { before } : {}) },
      ]);
      let reached = false;
      for (const s of page) {
        if (s.slot <= cursor) {
          reached = true;
          break;
        }
        fresh.push(s);
      }
      if (reached || page.length < PAGE) break;
      before = page[page.length - 1]!.signature;
    }

    let added = 0;
    let holdAt: number | null = null;
    for (const s of fresh.reverse()) {
      if (s.err || this.seen.has(s.signature)) continue;
      try {
        const rows = await this.rowsFor(s.signature);
        if (rows === null) throw new Error("transaction not available yet");
        added += this.o.store.insertTransfers(rows, this.o.now());
        this.remember(s.signature);
      } catch (e) {
        // Never step past a burn we could not read: hold the cursor before it.
        holdAt = holdAt === null ? s.slot : Math.min(holdAt, s.slot);
        this.o.log.warn("solana tx unreadable, will retry", { sig: s.signature, error: (e as Error).message.split("\n")[0] });
      }
    }

    const next = holdAt !== null ? Math.min(head - CURSOR_MARGIN_SLOTS, holdAt - 1) : head - CURSOR_MARGIN_SLOTS;
    this.o.store.setCursor(this.chain.key, Math.max(cursor, next), head, this.o.now());
    if (added > 0) this.o.log.info("burns indexed", { chain: this.chain.key, added });
    return fresh.length ? { added, signatures: fresh.length } : null;
  }

  /** Index one signature now (the widget's hint after a burn). */
  async ingest(signature: string): Promise<NewTransfer[]> {
    const rows = await this.rowsFor(signature);
    if (!rows) return [];
    this.o.store.insertTransfers(rows, this.o.now());
    this.remember(signature);
    return rows;
  }

  private remember(signature: string): void {
    this.seen.add(signature);
    if (this.seen.size > 5_000) this.seen.delete(this.seen.values().next().value!);
  }

  /** The Injective-bound burns in one transaction; null while the RPC cannot return it. */
  async rowsFor(signature: string): Promise<NewTransfer[] | null> {
    const tx = await this.getTransaction(signature);
    if (!tx) return null;
    if (tx.meta?.err) return [];
    let burns: ReturnType<typeof burnsInTransaction>;
    try {
      burns = burnsInTransaction(tx, signature);
    } catch (e) {
      if (!(tx.meta?.logMessages ?? []).some((l) => /Instruction: DepositForBurn/.test(l))) return [];
      burns = await this.burnsFromIris(signature, e as Error);
    }
    return burns.map((b, i) => ({
      ...toNewTransfer(
        { ...b.burn, depositor: b.owner },
        { srcDomain: this.chain.domain, txHash: signature, logIndex: i, blockNumber: BigInt(tx.slot), blockTime: tx.blockTime },
        this.o.ctx,
      ),
      event_account: b.eventAccount,
    }));
  }

  /** Circle decodes the burn from its own index; used only when the layout is new to us. */
  private async burnsFromIris(signature: string, cause: Error): Promise<ReturnType<typeof burnsInTransaction>> {
    if (!this.o.iris) throw cause;
    const messages = await this.o.iris.getMessages(this.chain.domain, signature as Hex);
    const out: ReturnType<typeof burnsInTransaction> = [];
    for (const m of messages) {
      if (!m.message || m.message === "0x") throw new Error(`Circle has not decoded ${signature} yet`);
      const header = decodeMessage(m.message);
      if (header.destinationDomain !== INJECTIVE_DOMAIN) continue;
      const body = decodeBurnMessage(header.body);
      out.push({
        owner: bytes32ToSolana(body.messageSender),
        eventAccount: null,
        burn: {
          withHook: body.hookData !== "0x",
          amount: body.amount,
          destinationDomain: header.destinationDomain,
          mintRecipient: body.mintRecipient.toLowerCase() as Hex,
          destinationCaller: header.destinationCaller.toLowerCase() as Hex,
          maxFee: body.maxFee,
          minFinalityThreshold: header.minFinalityThreshold,
          hookData: body.hookData,
        },
      });
    }
    if (out.length === 0) throw cause;
    return out;
  }

  private async getTransaction(signature: string): Promise<JsonTransaction | null> {
    const params = (version: number) => [signature, { encoding: "json", commitment: "confirmed", maxSupportedTransactionVersion: version }];
    try {
      // Solana now has version 1 transactions; older nodes reject asking for them.
      return await this.rpc<JsonTransaction | null>("getTransaction", params(1));
    } catch (e) {
      if (!/maxSupportedTransactionVersion|version/i.test((e as Error).message)) throw e;
      return this.rpc<JsonTransaction | null>("getTransaction", params(0));
    }
  }
}

/** Every deposit_for_burn(_with_hook) to Injective in a transaction, CPIs included, in execution order. */
export function burnsInTransaction(tx: JsonTransaction, signature = "") {
  const msg = tx.transaction?.message;
  if (!msg?.accountKeys || !msg.instructions) throw new Error(`unrecognised transaction layout ${signature}`);
  const keys = [...msg.accountKeys, ...(tx.meta?.loadedAddresses?.writable ?? []), ...(tx.meta?.loadedAddresses?.readonly ?? [])];
  const inner = new Map((tx.meta?.innerInstructions ?? []).map((g) => [g.index, g.instructions]));
  const ordered: JsonInstruction[] = [];
  msg.instructions.forEach((ix, i) => ordered.push(ix, ...(inner.get(i) ?? [])));

  const out: { owner: string; eventAccount: string | null; burn: NonNullable<ReturnType<typeof decodeSolanaBurn>> }[] = [];
  for (const ix of ordered) {
    if (keys[ix.programIdIndex] !== SOLANA_TOKEN_MESSENGER_MINTER_V2) continue;
    const burn = decodeSolanaBurn(base58.decode(ix.data));
    if (!burn || burn.destinationDomain !== INJECTIVE_DOMAIN) continue;
    const owner = keys[ix.accounts[SOLANA_BURN_ACCOUNTS.owner]!];
    if (!owner) continue;
    out.push({ owner, eventAccount: keys[ix.accounts[SOLANA_BURN_ACCOUNTS.messageSentEventData]!] ?? null, burn });
  }
  return out;
}

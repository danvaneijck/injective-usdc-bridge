import type { Hex } from "viem";
import {
  type BurnMessage,
  type CctpMessage,
  type IrisClient,
  type IrisMessage,
  type Network,
  chainByDomain,
  decodeBurnMessage,
  decodeMessage,
} from "injective-usdc-bridge";
import type { Phase, Store, TransferRow } from "./db.js";
import type { Logger } from "./log.js";
import { type RateLimiter, attestingDelay, expectedAttestMs, notFoundDelay, readyDelay } from "./timing.js";

const OPEN: Phase[] = ["not_found", "attesting", "ready", "expired"];
const REATTEST_EVERY_MS = 10 * 60_000;

export interface TrackerDeps {
  store: Store;
  iris: IrisClient;
  irisLimiter: RateLimiter;
  network: Network;
  /** Destination usedNonces. The only authority on delivery. */
  isNonceUsed: (domain: number, nonce: Hex) => Promise<boolean>;
  destinationBlock: (domain: number) => Promise<bigint>;
  /** Block time (ms) of a destination tx, so backfilled deliveries get their real time. */
  txTime?: (domain: number, txHash: Hex) => Promise<number | null>;
  log: Logger;
  now: () => number;
  batch?: number;
}

interface Attested {
  m: IrisMessage;
  header: CctpMessage;
  burn: BurnMessage;
}

export class Tracker {
  private readonly lastReattest = new Map<string, number>();

  constructor(private readonly d: TrackerDeps) {}

  /** Check every source tx with a due transfer. Returns how many txs were checked. */
  async tick(): Promise<number> {
    const due = this.d.store.dueTxs(this.d.now(), this.d.batch ?? 20);
    for (const { src_domain, tx_hash } of due) {
      try {
        await this.checkTx(src_domain, tx_hash);
      } catch (e) {
        this.d.log.warn("check failed", { src: src_domain, tx: tx_hash, error: (e as Error).message.split("\n")[0] });
        for (const row of this.d.store.byTx(src_domain, tx_hash)) {
          if (OPEN.includes(row.phase)) this.d.store.update(row, { next_check_at: this.d.now() + 30_000 }, this.d.now());
        }
      }
    }
    return due.length;
  }

  async checkTx(srcDomain: number, txHash: string): Promise<void> {
    const rows = this.d.store.byTx(srcDomain, txHash).filter((r) => OPEN.includes(r.phase));
    if (rows.length === 0) return;

    await this.d.irisLimiter.take();
    const messages = await this.d.iris.getMessages(srcDomain, txHash as Hex);
    const now = this.d.now();
    for (const row of rows) this.d.store.update(row, { checked_at: now }, now);

    if (messages.length === 0) {
      for (const row of rows) {
        this.d.store.update(row, { phase: "not_found", next_check_at: now + notFoundDelay(now - burnedAt(row)) }, now);
      }
      return;
    }

    const attested: Attested[] = [];
    for (const m of messages) {
      if (m.status !== "complete" || m.attestation === "PENDING" || !m.message || m.message === "0x") continue;
      const header = decodeMessage(m.message);
      attested.push({ m, header, burn: decodeBurnMessage(header.body) });
    }

    // One tx can carry several burns; pair each row with the message whose
    // destination, recipient and amount match, each message used once.
    const used = new Set<Attested>();
    for (const row of rows) {
      const match = attested.find(
        (a) =>
          !used.has(a) &&
          a.header.destinationDomain === row.dst_domain &&
          a.burn.mintRecipient.toLowerCase() === row.mint_recipient &&
          a.burn.amount.toString() === row.amount,
      );
      if (!match) {
        const age = now - burnedAt(row);
        const expected = expectedAttestMs(this.d.network, row.src_domain, row.min_finality);
        this.d.store.update(row, { phase: "attesting", next_check_at: now + attestingDelay(age, expected) }, now);
        continue;
      }
      used.add(match);
      await this.onAttested(row, match, now);
    }
  }

  private async onAttested(row: TransferRow, a: Attested, now: number): Promise<void> {
    const forwardTx = typeof a.m.forwardTxHash === "string" ? a.m.forwardTxHash.toLowerCase() : null;
    const attestedAt = row.attested_at ?? now;
    const base: Partial<TransferRow> = {
      event_nonce: a.m.eventNonce.toLowerCase(),
      message: a.m.message,
      attestation: a.m.attestation as string,
      fee_executed: a.burn.feeExecuted.toString(),
      forward_state: typeof a.m.forwardState === "string" ? a.m.forwardState : null,
      forward_tx: forwardTx,
      attested_at: attestedAt,
    };

    if (!chainByDomain(this.d.network, row.dst_domain)) {
      // A destination outside our registry: we cannot read its usedNonces.
      this.d.store.update(
        row,
        { ...base, phase: "ready", last_error: `destination domain ${row.dst_domain} not in registry`, next_check_at: now + 3_600_000 },
        now,
      );
      return;
    }

    if (await this.d.isNonceUsed(row.dst_domain, a.m.eventNonce)) {
      const mintedBy = row.minted_by ?? (forwardTx ? "circle" : "unknown");
      const mintTx = row.mint_tx ?? forwardTx;
      let deliveredAt = row.delivered_at;
      if (deliveredAt === null && mintTx && this.d.txTime) {
        deliveredAt = await this.d.txTime(row.dst_domain, mintTx as Hex).catch(() => null);
      }
      this.d.store.update(
        row,
        {
          ...base,
          phase: "delivered",
          delivered_at: deliveredAt ?? now,
          mint_tx: mintTx,
          minted_by: mintedBy,
          next_check_at: Number.MAX_SAFE_INTEGER,
        },
        now,
      );
      if (row.phase !== "delivered") {
        this.d.log.info("delivered", { src: row.src_domain, dst: row.dst_domain, tx: row.tx_hash, amount: row.amount, mintedBy });
      }
      return;
    }

    if (a.burn.expirationBlock > 0n) {
      const head = await this.d.destinationBlock(row.dst_domain);
      if (head >= a.burn.expirationBlock) {
        await this.maybeReattest(a.m.eventNonce, now);
        this.d.store.update(row, { ...base, phase: "expired", next_check_at: now + 30_000 }, now);
        return;
      }
    }

    this.d.store.update(row, { ...base, phase: "ready", next_check_at: now + readyDelay(now - attestedAt) }, now);
  }

  private async maybeReattest(nonce: Hex, now: number): Promise<void> {
    const last = this.lastReattest.get(nonce) ?? 0;
    if (now - last < REATTEST_EVERY_MS) return;
    this.lastReattest.set(nonce, now);
    await this.d.irisLimiter.take();
    try {
      await this.d.iris.reattest(nonce);
      this.d.log.info("reattest requested", { nonce });
    } catch (e) {
      this.d.log.warn("reattest failed", { nonce, error: (e as Error).message });
    }
  }
}

function burnedAt(row: TransferRow): number {
  return row.block_time ? row.block_time * 1000 : row.first_seen;
}

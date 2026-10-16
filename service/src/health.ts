import { formatEther, type Address, type PublicClient } from "viem";
import { type Network, chainByKey } from "injective-usdc-bridge";
import type { Mode } from "./config.js";
import type { Store } from "./db.js";
import { expectedAttestMs } from "./timing.js";

const INDEXER_STALE_MS = 5 * 60_000;

export interface HealthDeps {
  store: Store;
  network: Network;
  mode: Mode;
  chainKeys: string[];
  now: () => number;
  relayer?: { address: Address; client: PublicClient; lowInj: number };
}

export interface LaneHealth {
  chain: string;
  domain: number;
  indexedBlock: number | null;
  head: number | null;
  indexerUpdatedAt: string | null;
  waiting: number;
  oldestWaitingSec: number | null;
  expectedSec: number | null;
  lastAttestedAt: string | null;
  status: "ok" | "delayed" | "indexer_stalled" | "starting";
}

/**
 * "delayed" means Circle is slow to attest this source chain as a whole, which
 * the UI should show as a lane banner instead of "your transfer is stuck".
 */
export class Health {
  private relayerBalance: { inj: number; at: number } | null = null;

  constructor(private readonly d: HealthDeps) {}

  async refreshRelayerBalance(): Promise<void> {
    if (!this.d.relayer) return;
    const wei = await this.d.relayer.client.getBalance({ address: this.d.relayer.address });
    this.relayerBalance = { inj: Number(formatEther(wei)), at: this.d.now() };
  }

  report() {
    const now = this.d.now();
    const cursors = new Map(this.d.store.cursors().map((c) => [c.chain_key, c]));
    const waiting = this.d.store.oldestAttesting();
    const attested = new Map(this.d.store.lastAttested().map((r) => [r.src_domain, r.at]));

    const lanes: LaneHealth[] = this.d.chainKeys.map((key) => {
      const chain = chainByKey(this.d.network, key)!;
      const c = cursors.get(key);
      const mine = waiting.filter((w) => w.src_domain === chain.domain);
      let status: LaneHealth["status"] = c ? "ok" : "starting";
      let oldest: number | null = null;
      let expected: number | null = null;
      for (const w of mine) {
        const age = now - w.since;
        const exp = expectedAttestMs(this.d.network, w.src_domain, w.min_finality);
        if (oldest === null || age > oldest) {
          oldest = age;
          expected = exp;
        }
        if (age > 3 * exp) status = "delayed";
      }
      if (c && now - c.updated_at > INDEXER_STALE_MS) status = "indexer_stalled";
      const lastAt = attested.get(chain.domain);
      return {
        chain: key,
        domain: chain.domain,
        indexedBlock: c?.block ?? null,
        head: c?.head ?? null,
        indexerUpdatedAt: c ? new Date(c.updated_at).toISOString() : null,
        waiting: mine.reduce((n, w) => n + w.n, 0),
        oldestWaitingSec: oldest === null ? null : Math.round(oldest / 1000),
        expectedSec: expected === null ? null : Math.round(expected / 1000),
        lastAttestedAt: lastAt ? new Date(lastAt).toISOString() : null,
        status,
      };
    });

    const relayer = this.d.relayer
      ? {
          address: this.d.relayer.address,
          balanceInj: this.relayerBalance?.inj ?? null,
          low: this.relayerBalance ? this.relayerBalance.inj < this.d.relayer.lowInj : null,
        }
      : null;

    return {
      ok: lanes.every((l) => l.status === "ok" || l.status === "starting") && relayer?.low !== true,
      network: this.d.network,
      mode: this.d.mode,
      relayer,
      lanes,
      counts: this.d.store.phaseCounts(),
    };
  }
}

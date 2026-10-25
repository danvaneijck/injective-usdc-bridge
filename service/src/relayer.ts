import { type Account, type Address, type Hex, type PublicClient, type WalletClient, encodeFunctionData } from "viem";
import {
  CCTP_CONTRACTS,
  type EvmChain,
  type Network,
  bridgeReceiverAbi,
  bytes32ToAddress,
  feeOverrides,
  messageTransmitterV2Abi,
} from "injective-usdc-bridge";
import type { Kind, Store, TransferRow } from "./db.js";
import type { Logger } from "./log.js";
import type { Mode } from "./config.js";
import { relayRetryDelay } from "./timing.js";

const RELAYABLE: Kind[] = ["plain", "gas_drop", "legacy_gas_drop"];

/**
 * A deposit the relayer leaves for its depositor to mint: any kind we relay,
 * below the floor. Anyone can burn 1 micro-USDC to Injective, many per tx, and
 * name a receiver as the caller; relaying each would spend more INJ than it
 * moves. A real gas-drop deposit is far above it: the drop fee alone is $0.50.
 */
export function belowRelayFloor(row: Pick<TransferRow, "kind" | "amount">, minRelay: bigint): boolean {
  return RELAYABLE.includes(row.kind) && BigInt(row.amount) < minRelay;
}
const MAX_ATTEMPTS = 8;
/**
 * eth_estimateGas under-reports on Injective (Choice v2 measured it), and other
 * relayers send deposit mints at a 768k limit for 562k used. Injective bills
 * the whole limit, but 800k at the base fee is still ~0.00015 INJ.
 */
const RELAY_GAS_FLOOR = 800_000n;
const SHADOW_NOTE = "shadow: would relay";
const DUST_NOTE = "below the relay floor: left for self-mint";

export interface RelayerDeps {
  store: Store;
  network: Network;
  mode: Mode;
  injective: EvmChain;
  client: PublicClient;
  wallet?: WalletClient & { account: Account };
  bridgeReceiver?: Address;
  depositGraceSec: number;
  legacyGraceSec: number;
  /** Deposits below this (base units), of any kind, are never relayed. 0n relays everything. */
  minRelay?: bigint;
  isNonceUsed: (domain: number, nonce: Hex) => Promise<boolean>;
  log: Logger;
  now: () => number;
}

export interface RelayCall {
  to: Address;
  data: Hex;
  via: "message_transmitter" | "bridge_receiver" | "legacy_receiver";
}

/** The call that completes a deposit, chosen by who the burn allowed to mint. */
export function relayCallFor(row: TransferRow, network: Network, bridgeReceiver?: Address): RelayCall {
  const args = [row.message as Hex, row.attestation as Hex] as const;
  if (row.kind === "plain") {
    return {
      to: CCTP_CONTRACTS[network].messageTransmitter,
      data: encodeFunctionData({ abi: messageTransmitterV2Abi, functionName: "receiveMessage", args }),
      via: "message_transmitter",
    };
  }
  if (row.kind === "gas_drop") {
    if (!bridgeReceiver) throw new Error("gas_drop row without a configured BridgeReceiver");
    return {
      to: bridgeReceiver,
      data: encodeFunctionData({ abi: bridgeReceiverAbi, functionName: "relay", args }),
      via: "bridge_receiver",
    };
  }
  if (row.kind === "legacy_gas_drop") {
    // v1 GasDropReceiver has the same relay(bytes,bytes) entry point.
    return {
      to: bytes32ToAddress(row.destination_caller as Hex),
      data: encodeFunctionData({ abi: bridgeReceiverAbi, functionName: "relay", args }),
      via: "legacy_receiver",
    };
  }
  throw new Error(`Cannot relay kind ${row.kind}`);
}

export class Relayer {
  constructor(private readonly d: RelayerDeps) {}

  get address(): Address | undefined {
    return this.d.wallet?.account.address;
  }

  async tick(): Promise<number> {
    const now = this.d.now();
    const rows = this.d.store.relayCandidates(this.d.injective.domain, RELAYABLE, now, 5);
    let acted = 0;
    for (const row of rows) {
      const graceMs = (row.kind === "legacy_gas_drop" ? this.d.legacyGraceSec : this.d.depositGraceSec) * 1000;
      const readyAt = (row.attested_at ?? now) + graceMs;
      if (readyAt > now) {
        this.d.store.update(row, { next_relay_at: readyAt }, now);
        continue;
      }
      if (row.relay_attempts >= MAX_ATTEMPTS) continue;
      if (belowRelayFloor(row, this.d.minRelay ?? 0n)) {
        this.d.store.update(row, { last_error: DUST_NOTE, next_relay_at: Number.MAX_SAFE_INTEGER }, now);
        continue;
      }
      acted++;
      await this.relayOne(row);
    }
    return acted;
  }

  private async relayOne(row: TransferRow): Promise<void> {
    const now = this.d.now();
    const call = relayCallFor(row, this.d.network, this.d.bridgeReceiver);
    const ctx = { tx: row.tx_hash, src: row.src_domain, amount: row.amount, kind: row.kind, via: call.via };

    if (this.d.mode === "shadow" || !this.d.wallet) {
      if (row.last_error !== SHADOW_NOTE) this.d.log.info("shadow: would relay", ctx);
      this.d.store.update(row, { last_error: SHADOW_NOTE, next_relay_at: now + 10 * 60_000 }, now);
      return;
    }

    // Someone (the user, v1's backend, a rescuer) may have minted since the last check.
    if (await this.d.isNonceUsed(row.dst_domain, row.event_nonce as Hex)) {
      this.markDelivered(row, null, "unknown");
      return;
    }

    const account = this.d.wallet.account;
    try {
      await this.d.client.call({ account: account.address, to: call.to, data: call.data });
    } catch (e) {
      // A revert after someone else's mint looks like a failure ("Invalid caller"
      // or "Nonce already used"); only usedNonces can tell the two apart.
      if (await this.d.isNonceUsed(row.dst_domain, row.event_nonce as Hex)) {
        this.markDelivered(row, null, "unknown");
        return;
      }
      this.fail(row, `simulate: ${shortError(e)}`, ctx);
      return;
    }

    try {
      const gas = await this.d.client.estimateGas({ account: account.address, to: call.to, data: call.data });
      // No tip: the 1 gwei floor is a MetaMask workaround, and base fee alone
      // lands (measured 2026-10-16: ~560k gas at 0.16 gwei ≈ 0.00009 INJ a mint).
      const fees = await feeOverrides(this.d.client, this.d.injective, 0n);
      const hash = await this.d.wallet.sendTransaction({
        account,
        chain: null,
        to: call.to,
        data: call.data,
        gas: (gas * 3n) / 2n > RELAY_GAS_FLOOR ? (gas * 3n) / 2n : RELAY_GAS_FLOOR,
        ...fees,
      });
      this.d.log.info("relay sent", { ...ctx, hash });
      const receipt = await this.d.client.waitForTransactionReceipt({ hash, timeout: 90_000 });
      if (receipt.status === "success") {
        this.markDelivered(row, hash, "relayer");
        this.d.log.info("relayed", { ...ctx, hash, gasUsed: receipt.gasUsed });
      } else {
        this.fail(row, `reverted ${hash}`, ctx);
      }
    } catch (e) {
      this.fail(row, `send: ${shortError(e)}`, ctx);
    }
  }

  private markDelivered(row: TransferRow, mintTx: string | null, by: "relayer" | "unknown"): void {
    const now = this.d.now();
    this.d.store.update(
      row,
      {
        phase: "delivered",
        delivered_at: now,
        mint_tx: mintTx ?? row.mint_tx,
        minted_by: by,
        last_error: null,
        next_check_at: Number.MAX_SAFE_INTEGER,
      },
      now,
    );
  }

  private fail(row: TransferRow, error: string, ctx: Record<string, unknown>): void {
    const now = this.d.now();
    const attempts = row.relay_attempts + 1;
    const giveUp = attempts >= MAX_ATTEMPTS;
    this.d.store.update(
      row,
      { relay_attempts: attempts, last_error: error, next_relay_at: giveUp ? Number.MAX_SAFE_INTEGER : now + relayRetryDelay(attempts) },
      now,
    );
    (giveUp ? this.d.log.error : this.d.log.warn)(giveUp ? "relay gave up, needs a human" : "relay failed", {
      ...ctx,
      attempts,
      error,
    });
  }
}

function shortError(e: unknown): string {
  const err = e as { shortMessage?: string; message?: string };
  return (err.shortMessage ?? err.message ?? String(e)).split("\n")[0]!.slice(0, 300);
}

import type { Hex } from "viem";
import { isForwardHookData } from "./hookData.js";
import type { IrisClient, IrisMessage } from "./iris.js";
import {
  type BurnMessage,
  type CctpMessage,
  decodeBurnMessage,
  decodeMessage,
  isPermissionless,
} from "./message.js";

/**
 * - `not_found`: Iris has not indexed the tx. Normal for a few seconds after a
 *   burn; for longer it means a bad hash, a reverted burn, or an Iris outage
 *   (Iris stopped indexing Injective entirely on 2026-09-01).
 * - `attesting`: Iris saw the burn and is waiting for finality.
 * - `ready`: attested and not minted. Anyone can mint if `permissionless`.
 * - `expired`: attested, not minted, past expirationBlock. Needs reattest.
 * - `delivered`: the destination chain has consumed the nonce.
 */
export type TransferPhase = "not_found" | "attesting" | "ready" | "expired" | "delivered";

export interface TransferLeg {
  phase: TransferPhase;
  sourceDomain: number;
  txHash: Hex;
  eventNonce?: Hex;
  message?: Hex;
  attestation?: Hex;
  header?: CctpMessage;
  burn?: BurnMessage;
  /** Anyone may submit the mint (destinationCaller is zero). */
  permissionless?: boolean;
  /** The burn asked Circle's Forwarding Service to mint. */
  forwardRequested?: boolean;
  delayReason?: string | null;
}

export interface ResolveTransferOptions {
  iris: IrisClient;
  sourceDomain: number;
  txHash: Hex;
  /**
   * Reads MessageTransmitterV2.usedNonces on the destination. This is the only
   * authority on delivery: Iris "complete" means signed, not minted.
   * ⚠️ Right after a mint some RPCs still read 0 for a few seconds, so a
   * caller about to retry a mint should re-read first.
   */
  isNonceUsed: (destinationDomain: number, nonce: Hex) => Promise<boolean>;
  /** Destination head block, used to detect expiry. Optional. */
  destinationBlock?: (destinationDomain: number) => Promise<bigint>;
}

export async function resolveTransfer(opts: ResolveTransferOptions): Promise<TransferLeg[]> {
  const { sourceDomain, txHash } = opts;
  const messages = await opts.iris.getMessages(sourceDomain, txHash);
  if (messages.length === 0) return [{ phase: "not_found", sourceDomain, txHash }];
  return Promise.all(messages.map((m) => resolveLeg(opts, m)));
}

async function resolveLeg(opts: ResolveTransferOptions, m: IrisMessage): Promise<TransferLeg> {
  const base = {
    sourceDomain: opts.sourceDomain,
    txHash: opts.txHash,
    delayReason: m.delayReason ?? null,
  };
  const attested = m.status === "complete" && m.attestation !== "PENDING" && m.message !== "0x";
  if (!attested) return { ...base, phase: "attesting" };

  const header = decodeMessage(m.message);
  const burn = decodeBurnMessage(header.body);
  const leg: TransferLeg = {
    ...base,
    phase: "ready",
    eventNonce: m.eventNonce,
    message: m.message,
    attestation: m.attestation as Hex,
    header,
    burn,
    permissionless: isPermissionless(header),
    forwardRequested: isForwardHookData(burn.hookData),
  };

  if (await opts.isNonceUsed(header.destinationDomain, m.eventNonce)) {
    return { ...leg, phase: "delivered" };
  }
  if (burn.expirationBlock > 0n && opts.destinationBlock) {
    const head = await opts.destinationBlock(header.destinationDomain);
    if (head >= burn.expirationBlock) return { ...leg, phase: "expired" };
  }
  return leg;
}

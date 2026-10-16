import { type Address, type Hex, decodeAbiParameters, getAddress, hexToBigInt, size, slice } from "viem";
import {
  GAS_DROP_HOOK_MAGIC,
  INJECTIVE_DOMAIN,
  ZERO_BYTES32,
  addressToBytes32,
  bytes32ToAddress,
  bytes32ToSolana,
  forwardSetupOwner,
  isForwardHookData,
} from "injective-usdc-bridge";
import type { Kind, NewTransfer } from "./db.js";

export interface ClassifyContext {
  bridgeReceiver?: Address;
  legacyReceivers: Address[];
}

/** DepositForBurn args as viem decodes them. */
export interface DepositForBurnArgs {
  burnToken: Address;
  amount: bigint;
  depositor: Address;
  mintRecipient: Hex;
  destinationDomain: number;
  destinationTokenMessenger: Hex;
  destinationCaller: Hex;
  maxFee: bigint;
  minFinalityThreshold: number;
  hookData: Hex;
}

/** What classification needs from a burn, whichever chain it was made on. */
export type BurnFields = Pick<
  DepositForBurnArgs,
  "amount" | "mintRecipient" | "destinationDomain" | "destinationCaller" | "maxFee" | "minFinalityThreshold" | "hookData"
> & {
  /** 0x address on EVM chains, base58 wallet on Solana. */
  depositor: string;
};

/** CCTP's Solana domain, the same on mainnet and devnet. */
export const SOLANA_DOMAIN = 5;

/**
 * Hex (EVM hashes and addresses) compares lowercase; base58 (Solana
 * signatures and wallets) is case-sensitive and must stay as written.
 */
export function normalizeId(value: string): string {
  return value.startsWith("0x") ? value.toLowerCase() : value;
}

export interface BurnMeta {
  srcDomain: number;
  txHash: string;
  logIndex: number;
  blockNumber: bigint;
  blockTime: number | null;
}

/** Burns that touch Injective: everything burned on it, and everything bound for it. */
export function isRelevant(srcDomain: number, args: Pick<DepositForBurnArgs, "destinationDomain">): boolean {
  return srcDomain === INJECTIVE_DOMAIN || args.destinationDomain === INJECTIVE_DOMAIN;
}

export function classify(args: BurnFields, ctx: ClassifyContext): { kind: Kind; recipient: string | null } {
  const caller = args.destinationCaller.toLowerCase();
  if (caller === ZERO_BYTES32) {
    return {
      kind: isForwardHookData(args.hookData) ? "forward" : "plain",
      recipient: args.destinationDomain === SOLANA_DOMAIN ? solanaOwnerOrNull(args.hookData) : evmOrNull(args.mintRecipient),
    };
  }
  if (ctx.bridgeReceiver && caller === addressToBytes32(ctx.bridgeReceiver)) {
    return { kind: "gas_drop", recipient: gasDropRecipient(args.hookData) ?? normalizeId(args.depositor) };
  }
  if (ctx.legacyReceivers.some((r) => caller === addressToBytes32(r))) {
    return { kind: "legacy_gas_drop", recipient: legacyRecipient(args.hookData) ?? normalizeId(args.depositor) };
  }
  return { kind: "pinned_other", recipient: evmOrNull(args.mintRecipient) };
}

export function toNewTransfer(args: BurnFields, meta: BurnMeta, ctx: ClassifyContext): NewTransfer {
  const { kind, recipient } = classify(args, ctx);
  return {
    src_domain: meta.srcDomain,
    tx_hash: normalizeId(meta.txHash),
    log_index: meta.logIndex,
    dst_domain: args.destinationDomain,
    direction: meta.srcDomain === INJECTIVE_DOMAIN ? "withdraw" : "deposit",
    block_number: Number(meta.blockNumber),
    block_time: meta.blockTime,
    depositor: normalizeId(args.depositor),
    mint_recipient: args.mintRecipient.toLowerCase(),
    recipient,
    destination_caller: args.destinationCaller.toLowerCase(),
    amount: args.amount.toString(),
    max_fee: args.maxFee.toString(),
    min_finality: args.minFinalityThreshold,
    hook_data: args.hookData.toLowerCase(),
    kind,
  };
}

/**
 * A burn to Solana names the wallet's USDC account, not the wallet. The wallet
 * is in the hook only when Circle was asked to create that account; otherwise
 * the tracker looks it up once the account exists.
 */
function solanaOwnerOrNull(hookData: Hex): string | null {
  const owner = forwardSetupOwner(hookData);
  return owner ? bytes32ToSolana(owner) : null;
}

function evmOrNull(b32: Hex): string | null {
  try {
    return bytes32ToAddress(b32).toLowerCase();
  } catch {
    return null; // e.g. a Solana token account
  }
}

/** BridgeReceiver hook: abi.encode(bytes4 "IUB1", address recipient, uint256 maxDropFee). */
function gasDropRecipient(hook: Hex): string | null {
  if (size(hook) < 96 || slice(hook, 0, 4).toLowerCase() !== GAS_DROP_HOOK_MAGIC) return null;
  return evmOrNull(slice(hook, 32, 64));
}

/** v1 GasDropReceiver hook: abi.encode(address recipient, uint256 sponsorFee, uint256 injDrop). */
function legacyRecipient(hook: Hex): string | null {
  if (size(hook) < 96 || hexToBigInt(slice(hook, 0, 12)) !== 0n) return null;
  try {
    const [recipient] = decodeAbiParameters([{ type: "address" }], slice(hook, 0, 32));
    return getAddress(recipient).toLowerCase();
  } catch {
    return null;
  }
}

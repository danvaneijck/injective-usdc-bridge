import { type Address, type Hex, decodeAbiParameters, getAddress, hexToBigInt, size, slice } from "viem";
import {
  GAS_DROP_HOOK_MAGIC,
  INJECTIVE_DOMAIN,
  ZERO_BYTES32,
  addressToBytes32,
  bytes32ToAddress,
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

export interface BurnMeta {
  srcDomain: number;
  txHash: Hex;
  logIndex: number;
  blockNumber: bigint;
  blockTime: number | null;
}

/** Burns that touch Injective: everything burned on it, and everything bound for it. */
export function isRelevant(srcDomain: number, args: Pick<DepositForBurnArgs, "destinationDomain">): boolean {
  return srcDomain === INJECTIVE_DOMAIN || args.destinationDomain === INJECTIVE_DOMAIN;
}

export function classify(args: DepositForBurnArgs, ctx: ClassifyContext): { kind: Kind; recipient: string | null } {
  const caller = args.destinationCaller.toLowerCase();
  if (caller === ZERO_BYTES32) {
    return {
      kind: isForwardHookData(args.hookData) ? "forward" : "plain",
      recipient: evmOrNull(args.mintRecipient),
    };
  }
  if (ctx.bridgeReceiver && caller === addressToBytes32(ctx.bridgeReceiver)) {
    return { kind: "gas_drop", recipient: gasDropRecipient(args.hookData) ?? args.depositor.toLowerCase() };
  }
  if (ctx.legacyReceivers.some((r) => caller === addressToBytes32(r))) {
    return { kind: "legacy_gas_drop", recipient: legacyRecipient(args.hookData) ?? args.depositor.toLowerCase() };
  }
  return { kind: "pinned_other", recipient: evmOrNull(args.mintRecipient) };
}

export function toNewTransfer(args: DepositForBurnArgs, meta: BurnMeta, ctx: ClassifyContext): NewTransfer {
  const { kind, recipient } = classify(args, ctx);
  return {
    src_domain: meta.srcDomain,
    tx_hash: meta.txHash.toLowerCase(),
    log_index: meta.logIndex,
    dst_domain: args.destinationDomain,
    direction: meta.srcDomain === INJECTIVE_DOMAIN ? "withdraw" : "deposit",
    block_number: Number(meta.blockNumber),
    block_time: meta.blockTime,
    depositor: args.depositor.toLowerCase(),
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

import { encodeArgs } from "./abiEncode.js";
import type { Address, Hex } from "./hex.js";

/** Hook magic expected by BridgeReceiver ("IUB1"). */
export const GAS_DROP_HOOK_MAGIC: Hex = "0x49554231";

export const bridgeReceiverAbi = [
  { name: "relay", type: "function", stateMutability: "nonpayable", inputs: [{ type: "bytes", name: "message" }, { type: "bytes", name: "attestation" }], outputs: [] },
  { name: "dropWei", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { name: "dropFee", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { name: "dropsPaused", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "bool" }] },
  { name: "feeBps", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { name: "claim", type: "function", stateMutability: "nonpayable", inputs: [{ type: "address", name: "to" }], outputs: [] },
  { name: "escrow", type: "function", stateMutability: "view", inputs: [{ type: "bytes32", name: "account" }], outputs: [{ type: "uint256" }] },
  { name: "accruedFees", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { name: "sweepFees", type: "function", stateMutability: "nonpayable", inputs: [{ type: "uint256", name: "amount" }, { type: "address", name: "to" }], outputs: [] },
  { name: "Relayed", type: "event", inputs: [{ type: "bytes32", name: "nonce", indexed: true }, { type: "address", name: "recipient", indexed: true }, { type: "uint256", name: "minted" }, { type: "uint256", name: "usdcPaid" }, { type: "uint256", name: "dropFeeCharged" }, { type: "uint256", name: "injDropped" }, { type: "uint256", name: "bridgeFeeCharged" }] },
  { name: "DropSkipped", type: "event", inputs: [{ type: "bytes32", name: "nonce", indexed: true }, { type: "address", name: "recipient", indexed: true }, { type: "uint8", name: "reason" }] },
] as const;

/**
 * Hook data for a deposit routed through BridgeReceiver:
 * abi.encode(bytes4 "IUB1", address recipient, uint256 maxDropFee).
 * `maxDropFee` caps what the user agrees to pay if the price moves between
 * burn and relay; 0 means no drop.
 */
export function encodeGasDropHook(recipient: Address, maxDropFee: bigint): Hex {
  return encodeArgs([
    { type: "bytes4", value: GAS_DROP_HOOK_MAGIC },
    { type: "address", value: recipient },
    { type: "uint", bits: 256, value: maxDropFee },
  ]);
}

export interface GasDropConfig {
  receiver: Address;
  dropWei: bigint;
  dropFee: bigint;
  paused: boolean;
  /** dropWei > 0 and not paused. Float level is the service's concern. */
  available: boolean;
}

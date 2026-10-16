import {
  type Address,
  type Hex,
  type PublicClient,
  encodeAbiParameters,
  getAddress,
  parseAbi,
} from "viem";

/** Hook magic expected by BridgeReceiver ("IUB1"). */
export const GAS_DROP_HOOK_MAGIC: Hex = "0x49554231";

export const bridgeReceiverAbi = parseAbi([
  "function relay(bytes message, bytes attestation)",
  "function dropWei() view returns (uint256)",
  "function dropFee() view returns (uint256)",
  "function dropsPaused() view returns (bool)",
  "function feeBps() view returns (uint256)",
  "function claim(address to)",
  "function escrow(bytes32 account) view returns (uint256)",
  "event Relayed(bytes32 indexed nonce, address indexed recipient, uint256 minted, uint256 usdcPaid, uint256 dropFeeCharged, uint256 injDropped, uint256 bridgeFeeCharged)",
  "event DropSkipped(bytes32 indexed nonce, address indexed recipient, uint8 reason)",
]);

/**
 * Hook data for a deposit routed through BridgeReceiver:
 * abi.encode(bytes4 "IUB1", address recipient, uint256 maxDropFee).
 * `maxDropFee` caps what the user agrees to pay if the price moves between
 * burn and relay; 0 means no drop.
 */
export function encodeGasDropHook(recipient: Address, maxDropFee: bigint): Hex {
  return encodeAbiParameters(
    [{ type: "bytes4" }, { type: "address" }, { type: "uint256" }],
    [GAS_DROP_HOOK_MAGIC, getAddress(recipient), maxDropFee],
  );
}

export interface GasDropConfig {
  receiver: Address;
  dropWei: bigint;
  dropFee: bigint;
  paused: boolean;
  /** dropWei > 0 and not paused. Float level is the service's concern. */
  available: boolean;
}

export async function readGasDropConfig(
  client: PublicClient,
  receiver: Address,
): Promise<GasDropConfig> {
  const [dropWei, dropFee, paused] = await Promise.all([
    client.readContract({ address: receiver, abi: bridgeReceiverAbi, functionName: "dropWei" }),
    client.readContract({ address: receiver, abi: bridgeReceiverAbi, functionName: "dropFee" }),
    client.readContract({ address: receiver, abi: bridgeReceiverAbi, functionName: "dropsPaused" }),
  ]);
  return { receiver, dropWei, dropFee, paused, available: dropWei > 0n && !paused };
}

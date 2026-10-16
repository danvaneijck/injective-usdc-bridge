import type { Address, Hex } from "viem";

export type Network = "mainnet" | "testnet";

/**
 * CCTP V2 deploys TokenMessengerV2 and MessageTransmitterV2 at one address on
 * every EVM chain of a network, so a single pair covers the whole registry.
 */
export const CCTP_CONTRACTS: Record<
  Network,
  { tokenMessenger: Address; messageTransmitter: Address }
> = {
  mainnet: {
    tokenMessenger: "0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d",
    messageTransmitter: "0x81D40F21F12A8F0E3252Bccb954D722d4c464B64",
  },
  testnet: {
    tokenMessenger: "0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA",
    messageTransmitter: "0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275",
  },
};

/**
 * Injective-side BridgeReceiver for gas-drop deposits (contracts/), owned by
 * the Choice Safe. Mainnet: deployed and Blockscout-verified 2026-10-16.
 */
export const BRIDGE_RECEIVER: Record<Network, Address | undefined> = {
  mainnet: "0xcA5A96ECF72B3656eF7cF60BDAA42FCdb218cd4A",
  testnet: undefined,
};

export const IRIS_URLS: Record<Network, string> = {
  mainnet: "https://iris-api.circle.com",
  testnet: "https://iris-api-sandbox.circle.com",
};

/** Finality thresholds accepted by depositForBurn. */
export const FINALITY = {
  fast: 1000,
  standard: 2000,
} as const;

export type Speed = keyof typeof FINALITY;

export const USDC_DECIMALS = 6;

export const ZERO_BYTES32: Hex =
  "0x0000000000000000000000000000000000000000000000000000000000000000";

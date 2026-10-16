import type { Network } from "../constants.js";
import type { Direction } from "../quote.js";

/** EIP-1193, as far as the widget uses it. */
export interface Eip1193Provider {
  request(args: { method: string; params?: unknown }): Promise<unknown>;
  on?(event: string, listener: (...args: unknown[]) => void): void;
  removeListener?(event: string, listener: (...args: unknown[]) => void): void;
}

/**
 * The host's wallet. The widget never connects one itself: it asks the host
 * through `onConnectWallet`, so it works beside any wallet library (viem,
 * ethers v5 or v6, Injective's wallet-strategy). Keplr and Leap users pass
 * their `.ethereum` provider.
 */
export interface BridgeWallet {
  address: string | null;
  provider: Eip1193Provider | null;
}

export interface BridgeProps {
  wallet: BridgeWallet;
  /** Opens the host's wallet picker. Without it the button only says to connect. */
  onConnectWallet?: () => void;
  network?: Network;
  /** The bridge service. Defaults to Choice's. "" means this page's own origin. */
  apiUrl?: string;
  /** Peer chain the form opens on. */
  defaultChain?: string;
  defaultDirection?: Direction;
  /** Per chain key, RPCs placed ahead of the registry's (for balance reads and receipts). */
  rpcUrls?: Partial<Record<string, string[]>>;
  className?: string;
}

export const DEFAULT_API_URL = "https://bridge-api.choice.exchange";

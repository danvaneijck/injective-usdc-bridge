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

/**
 * The host's Solana wallet, for transfers from Solana. Shaped after Wallet
 * Standard's solana:signAndSendTransaction / solana:signTransaction, which
 * take and return wire-format bytes, so any wallet library can supply it.
 * The transaction arrives already signed by a one-off account the burn
 * creates; the wallet adds the owner's signature.
 */
export interface SolanaWallet {
  /** Base58 wallet address. */
  address: string;
  /** Preferred: the wallet signs and broadcasts. Returns the signature (base58 or raw bytes). */
  signAndSendTransaction?: (transaction: Uint8Array) => Promise<string | Uint8Array>;
  /** Otherwise: the wallet signs and the widget broadcasts. Returns the signed wire bytes. */
  signTransaction?: (transaction: Uint8Array) => Promise<Uint8Array>;
}

export interface BridgeProps {
  wallet: BridgeWallet;
  /** Opens the host's wallet picker. Without it the button only says to connect. */
  onConnectWallet?: () => void;
  /** Solana wallet, for bridging from Solana. Withdrawals to Solana need only an address. */
  solanaWallet?: SolanaWallet | null;
  /** Opens the host's Solana wallet picker. */
  onConnectSolanaWallet?: () => void;
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

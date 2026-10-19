import type { Network } from "../constants.js";
import type { Direction } from "../quote.js";
import type { TransferView } from "./api.js";

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

/** A wallet to send deposits from (BridgeProps.sourceWallet). */
export interface SourceWallet extends BridgeWallet {
  /** What the host calls it ("MetaMask"), shown beside the address. */
  label?: string;
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

/** A burn the widget just signed, as handed to `onSent`. */
export interface SentTransfer {
  direction: Direction;
  /** Chain keys, e.g. "base" and "injective". */
  source: string;
  destination: string;
  /** CCTP domain and transaction (0x hash, or base58 signature on Solana) of the burn. */
  domain: number;
  txHash: string;
  /** USDC base units burned (6 decimals). */
  amount: bigint;
  /** What the quote promised at least, in USDC base units. */
  minReceived: bigint;
  recipient: string;
}

/** Props both the form and the tracking card take. */
export interface WidgetCommonProps {
  /** Solana wallet, for bridging from Solana. Withdrawals to Solana need only an address. */
  solanaWallet?: SolanaWallet | null;
  /** Opens the host's Solana wallet picker. */
  onConnectSolanaWallet?: () => void;
  /**
   * For hosts with no Solana wallet code: the widget finds Solana wallets
   * (Wallet Standard: Phantom, Solflare, Backpack...) and connects them
   * itself, with its own picker. Ignored when `solanaWallet` is passed.
   */
  builtInSolanaWallet?: boolean;
  network?: Network;
  /** The bridge service. Defaults to Choice's. "" means this page's own origin. */
  apiUrl?: string;
  /**
   * Show transfers' progress in front of the page title ("12 min left | ...").
   * Off by default: the title is the host's.
   */
  tabTitle?: boolean;
  /** Per chain key, RPCs placed ahead of the registry's (for balance reads and receipts). */
  rpcUrls?: Partial<Record<string, string[]>>;
  /**
   * Drop the widget's own card (width cap, background, border, shadow), for a
   * host that puts it inside a card or modal of its own.
   */
  bare?: boolean;
  /** A transfer seen on its way in this session has landed. Fires once per transfer. */
  onDelivered?: (transfer: TransferView) => void;
  className?: string;
}

export interface BridgeProps extends WidgetCommonProps {
  wallet: BridgeWallet;
  /** Opens the host's wallet picker. Without it the button only says to connect. */
  onConnectWallet?: () => void;
  /**
   * Another EVM wallet to send deposits from, for USDC held somewhere other
   * than the account (`wallet`). It signs the burn of a deposit from an EVM
   * chain and nothing else: `wallet` stays the default recipient of deposits
   * and signs withdrawals. Null or no address: deposits come from `wallet`.
   */
  sourceWallet?: SourceWallet | null;
  /**
   * Opens the host's picker for `sourceWallet`. With it, the sending address
   * in From's head is a button that calls this, on deposits from EVM chains.
   */
  onPickSourceWallet?: () => void;
  /** Peer chain the form opens on. Without it, deposits start where the wallet holds USDC. */
  defaultChain?: string;
  defaultDirection?: Direction;
  /**
   * USDC the amount field starts with, as decimal text ("25" or "12.5"). Read
   * on mount: give the widget a new `key` to start over with another.
   */
  defaultAmount?: string;
  /** The user signed a burn. The form has moved on to tracking it. */
  onSent?: (transfer: SentTransfer) => void;
  /**
   * Which app the transfer came from, for the service's per-app counts
   * ("choice", "sprout"): lowercase letters, digits and dashes, 32 at most.
   * A label only; it is sent with the tracking hint and moves no money.
   */
  app?: string;
}

export const DEFAULT_API_URL = "https://bridge-api.choice.exchange";

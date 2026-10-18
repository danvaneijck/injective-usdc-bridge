import { useCallback, useEffect, useMemo, useState } from "react";
import { showToast } from "./toast.js";
import type { SolanaWallet } from "./types.js";

/**
 * Solana wallets found through Wallet Standard (how Phantom, Solflare,
 * Backpack and MetaMask expose Solana), the counterpart of EIP-6963 on the EVM
 * side. The registration handshake is small enough to implement here rather
 * than add a dependency. The widget uses it for `builtInSolanaWallet`; a host
 * with its own wallet menu can use the hook directly.
 */

export interface StandardAccount {
  address: string;
  publicKey: Uint8Array;
  chains: readonly string[];
  features: readonly string[];
}

interface ConnectFeature {
  connect(input?: { silent?: boolean }): Promise<{ accounts: readonly StandardAccount[] }>;
}
interface DisconnectFeature {
  disconnect(): Promise<void>;
}
interface EventsFeature {
  on(event: "change", listener: (props: { accounts?: readonly StandardAccount[] }) => void): () => void;
}
interface SignAndSendFeature {
  signAndSendTransaction(...inputs: { account: StandardAccount; transaction: Uint8Array; chain: string }[]): Promise<{ signature: Uint8Array }[]>;
}
interface SignFeature {
  signTransaction(...inputs: { account: StandardAccount; transaction: Uint8Array; chain?: string }[]): Promise<{ signedTransaction: Uint8Array }[]>;
}

export interface StandardWallet {
  name: string;
  icon: string;
  chains: readonly string[];
  accounts: readonly StandardAccount[];
  features: Record<string, unknown>;
}

const CHAIN = "solana:mainnet";
/** Where the last connected wallet's name is kept, for a quiet reconnect next visit. */
export const SOLANA_WALLET_KEY = "iub:solana-wallet";

const feature = <T>(w: StandardWallet, name: string) => w.features[name] as T | undefined;

function isSolanaWallet(w: StandardWallet): boolean {
  return (
    w.chains.some((c) => c.startsWith("solana:")) &&
    feature(w, "standard:connect") !== undefined &&
    (feature(w, "solana:signAndSendTransaction") !== undefined || feature(w, "solana:signTransaction") !== undefined)
  );
}

function remember(key: string, name: string | null) {
  try {
    if (name) localStorage.setItem(key, name);
    else localStorage.removeItem(key);
  } catch {
    // Storage blocked: the user reconnects next visit.
  }
}

export function lastSolanaWallet(key = SOLANA_WALLET_KEY): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

/** Every Wallet Standard wallet that can sign on Solana; none while `enabled` is false. */
function useStandardWallets(enabled: boolean): StandardWallet[] {
  const [wallets, setWallets] = useState<StandardWallet[]>([]);
  useEffect(() => {
    if (!enabled) return;
    const registered = new Set<StandardWallet>();
    const update = () => setWallets([...registered].filter(isSolanaWallet));
    const api = {
      register: (...ws: StandardWallet[]) => {
        for (const w of ws) registered.add(w);
        update();
        return () => {
          for (const w of ws) registered.delete(w);
          update();
        };
      },
    };
    // Wallets loaded after us announce themselves; wallets loaded before us
    // answer app-ready.
    const onRegister = (e: Event) => {
      const callback = (e as CustomEvent<(a: typeof api) => void>).detail;
      if (typeof callback === "function") callback(api);
    };
    window.addEventListener("wallet-standard:register-wallet", onRegister);
    window.dispatchEvent(new CustomEvent("wallet-standard:app-ready", { detail: api }));
    return () => window.removeEventListener("wallet-standard:register-wallet", onRegister);
  }, [enabled]);
  return enabled ? wallets : [];
}

export interface SolanaWalletState {
  wallets: StandardWallet[];
  active: StandardWallet | null;
  address: string | null;
  connect(w: StandardWallet): Promise<void>;
  disconnect(): void;
  /** What the widget takes. */
  bridgeWallet: SolanaWallet | null;
}

export interface SolanaWalletOptions {
  /** False leaves Wallet Standard alone (no listeners, no reconnect). Default true. */
  enabled?: boolean;
  /** localStorage key for the last wallet. Default SOLANA_WALLET_KEY. */
  storageKey?: string;
}

export function useSolanaWallet({ enabled = true, storageKey = SOLANA_WALLET_KEY }: SolanaWalletOptions = {}): SolanaWalletState {
  const wallets = useStandardWallets(enabled);
  const [active, setActive] = useState<StandardWallet | null>(null);
  const [account, setAccount] = useState<StandardAccount | null>(null);

  const pick = (accounts: readonly StandardAccount[]) => accounts.find((a) => a.chains.some((c) => c.startsWith("solana:"))) ?? accounts[0] ?? null;

  // Quietly reconnect the last wallet; `silent` never prompts.
  useEffect(() => {
    if (active) return;
    const last = lastSolanaWallet(storageKey);
    const w = last ? wallets.find((x) => x.name === last) : undefined;
    if (!w) return;
    void feature<ConnectFeature>(w, "standard:connect")
      ?.connect({ silent: true })
      .then(({ accounts }) => {
        const a = pick(accounts);
        if (a) {
          setActive(w);
          setAccount(a);
        }
      })
      .catch(() => undefined);
  }, [wallets, active, storageKey]);

  // Follow account switches inside the wallet.
  useEffect(() => {
    const events = active ? feature<EventsFeature>(active, "standard:events") : undefined;
    if (!events) return;
    return events.on("change", ({ accounts }) => {
      if (!accounts) return;
      const a = pick(accounts);
      if (a) setAccount(a);
      else {
        setActive(null);
        setAccount(null);
        remember(storageKey, null);
      }
    });
  }, [active, storageKey]);

  const connect = useCallback(async (w: StandardWallet) => {
    try {
      const { accounts } = await feature<ConnectFeature>(w, "standard:connect")!.connect();
      const a = pick(accounts);
      if (!a) throw new Error("The wallet returned no Solana account");
      setActive(w);
      setAccount(a);
      remember(storageKey, w.name);
    } catch (e) {
      const err = e as { code?: number; message?: string };
      showToast(err.code === 4001 || /reject|denied|cancel/i.test(err.message ?? "") ? "Connection cancelled in your wallet." : (err.message ?? "Could not connect"));
    }
  }, [storageKey]);

  const disconnect = useCallback(() => {
    if (active) void feature<DisconnectFeature>(active, "standard:disconnect")?.disconnect().catch(() => undefined);
    setActive(null);
    setAccount(null);
    remember(storageKey, null);
  }, [active, storageKey]);

  const bridgeWallet = useMemo<SolanaWallet | null>(() => {
    if (!active || !account) return null;
    const sas = feature<SignAndSendFeature>(active, "solana:signAndSendTransaction");
    const st = feature<SignFeature>(active, "solana:signTransaction");
    return {
      address: account.address,
      ...(sas
        ? { signAndSendTransaction: async (transaction: Uint8Array) => (await sas.signAndSendTransaction({ account, transaction, chain: CHAIN }))[0]!.signature }
        : {}),
      ...(st ? { signTransaction: async (transaction: Uint8Array) => (await st.signTransaction({ account, transaction, chain: CHAIN }))[0]!.signedTransaction } : {}),
    };
  }, [active, account]);

  return { wallets, active, address: account?.address ?? null, connect, disconnect, bridgeWallet };
}

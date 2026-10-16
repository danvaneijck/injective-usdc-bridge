import { useCallback, useEffect, useState } from "react";
import type { Eip1193Provider } from "injective-usdc-bridge/react";

/**
 * Browser wallets for the standalone site, found through EIP-6963 so MetaMask,
 * Rabby, Keplr, Leap, OKX and the rest each show up by name instead of
 * fighting over window.ethereum. The widget itself has no wallet code.
 */

export interface WalletInfo {
  uuid: string;
  name: string;
  icon: string;
  rdns: string;
}

export interface FoundWallet {
  info: WalletInfo;
  provider: Eip1193Provider;
}

const LAST_KEY = "iub-site:wallet";

function remember(rdns: string | null) {
  try {
    if (rdns) localStorage.setItem(LAST_KEY, rdns);
    else localStorage.removeItem(LAST_KEY);
  } catch {
    // Storage blocked: the user reconnects next visit.
  }
}

/** The rdns of the wallet this browser last connected, if any. */
export function lastWallet(): string | null {
  return remembered();
}

function remembered(): string | null {
  try {
    return localStorage.getItem(LAST_KEY);
  } catch {
    return null;
  }
}

/** Every wallet that announces itself, plus window.ethereum when none does. */
function useDiscovery(): FoundWallet[] {
  const [found, setFound] = useState<FoundWallet[]>([]);
  useEffect(() => {
    const onAnnounce = (e: Event) => {
      const detail = (e as CustomEvent<FoundWallet>).detail;
      if (!detail?.info?.rdns) return;
      setFound((prev) => (prev.some((w) => w.info.uuid === detail.info.uuid) ? prev : [...prev, detail]));
    };
    window.addEventListener("eip6963:announceProvider", onAnnounce);
    window.dispatchEvent(new Event("eip6963:requestProvider"));
    const legacy = setTimeout(() => {
      const eth = (window as unknown as { ethereum?: Eip1193Provider }).ethereum;
      setFound((prev) =>
        prev.length || !eth ? prev : [{ info: { uuid: "injected", name: "Browser wallet", icon: "", rdns: "injected" }, provider: eth }],
      );
    }, 400);
    return () => {
      window.removeEventListener("eip6963:announceProvider", onAnnounce);
      clearTimeout(legacy);
    };
  }, []);
  return found;
}

export interface WalletState {
  wallets: FoundWallet[];
  active: FoundWallet | null;
  address: string | null;
  connect(w: FoundWallet): Promise<void>;
  disconnect(): void;
  error: string | null;
}

export function useWallet(): WalletState {
  const wallets = useDiscovery();
  const [active, setActive] = useState<FoundWallet | null>(null);
  const [address, setAddress] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Quietly reconnect the last wallet: eth_accounts never prompts.
  useEffect(() => {
    if (active) return;
    const last = remembered();
    const w = last ? wallets.find((x) => x.info.rdns === last) : undefined;
    if (!w) return;
    void (w.provider.request({ method: "eth_accounts" }) as Promise<string[]>)
      .then((accounts) => {
        if (accounts[0]) {
          setActive(w);
          setAddress(accounts[0]);
        }
      })
      .catch(() => undefined);
  }, [wallets, active]);

  useEffect(() => {
    if (!active?.provider.on) return;
    const onAccounts = (...args: unknown[]) => {
      const accounts = args[0] as string[];
      if (accounts[0]) setAddress(accounts[0]);
      else {
        setActive(null);
        setAddress(null);
        remember(null);
      }
    };
    active.provider.on("accountsChanged", onAccounts);
    return () => active.provider.removeListener?.("accountsChanged", onAccounts);
  }, [active]);

  const connect = useCallback(async (w: FoundWallet) => {
    setError(null);
    try {
      const accounts = (await w.provider.request({ method: "eth_requestAccounts" })) as string[];
      if (!accounts[0]) throw new Error("The wallet returned no account");
      setActive(w);
      setAddress(accounts[0]);
      remember(w.info.rdns);
    } catch (e) {
      const err = e as { code?: number; message?: string };
      setError(err.code === 4001 ? "Connection cancelled in your wallet." : (err.message ?? "Could not connect"));
    }
  }, []);

  const disconnect = useCallback(() => {
    setActive(null);
    setAddress(null);
    remember(null);
  }, []);

  return { wallets, active, address, connect, disconnect, error };
}

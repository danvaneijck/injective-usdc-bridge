import { useCallback, useEffect, useRef, useState } from "react";
import type { Eip1193Provider } from "injective-usdc-bridge/react";
import { type WcSession, WC_PROJECT_ID, abortWalletConnect, connectWalletConnect, restoreWalletConnect } from "./walletConnect";

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
  /** Null when no WalletConnect project id is configured. */
  walletConnect: {
    connect(): Promise<void>;
    cancel(): void;
    /** The pairing link while one is waiting for a wallet. */
    uri: string | null;
  } | null;
}

const WC_RDNS = "walletconnect";

export function useWallet(): WalletState {
  const wallets = useDiscovery();
  const [active, setActive] = useState<FoundWallet | null>(null);
  const [address, setAddress] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [wcUri, setWcUri] = useState<string | null>(null);
  const wc = useRef<{ session: WcSession; stop: () => void } | null>(null);
  const wcCancelled = useRef(false);

  const adopt = useCallback((session: WcSession) => {
    wc.current?.stop();
    const stop = session.onEnd(() => {
      wc.current = null;
      setActive(null);
      setAddress(null);
      remember(null);
    });
    wc.current = { session, stop };
    setActive({ info: { uuid: WC_RDNS, name: session.name, icon: session.icon, rdns: WC_RDNS }, provider: session.provider });
    setAddress(session.address);
    remember(WC_RDNS);
  }, []);

  // A WalletConnect session outlives the page: pick it back up.
  useEffect(() => {
    if (!WC_PROJECT_ID || remembered() !== WC_RDNS) return;
    void restoreWalletConnect()
      .then((s) => (s ? adopt(s) : remember(null)))
      .catch(() => undefined);
  }, [adopt]);

  const connectWc = useCallback(async () => {
    setError(null);
    wcCancelled.current = false;
    try {
      adopt(await connectWalletConnect(setWcUri));
    } catch (e) {
      if (!wcCancelled.current) setError(friendly(e));
    } finally {
      setWcUri(null);
    }
  }, [adopt]);

  const cancelWc = useCallback(() => {
    wcCancelled.current = true;
    setWcUri(null);
    abortWalletConnect();
  }, []);

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
      setError(friendly(e));
    }
  }, []);

  const disconnect = useCallback(() => {
    if (wc.current) {
      wc.current.stop();
      void wc.current.session.disconnect().catch(() => undefined);
      wc.current = null;
    }
    setActive(null);
    setAddress(null);
    remember(null);
  }, []);

  return {
    wallets,
    active,
    address,
    connect,
    disconnect,
    error,
    walletConnect: WC_PROJECT_ID ? { connect: connectWc, cancel: cancelWc, uri: wcUri } : null,
  };
}

function friendly(e: unknown): string {
  const err = e as { code?: number; message?: string };
  if (err.code === 4001 || err.code === 5000 || /rejected|denied/i.test(err.message ?? "")) return "Connection cancelled in your wallet.";
  return err.message ?? "Could not connect";
}

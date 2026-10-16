import { type ReactNode, type RefObject, useEffect, useRef, useState } from "react";
import { type FoundWallet, type WalletState, lastWallet } from "./wallets";

/** Keeps something mounted while it animates out. */
function usePresence(open: boolean, ms = 200): { mounted: boolean; closing: boolean } {
  const [mounted, setMounted] = useState(open);
  useEffect(() => {
    if (open) {
      setMounted(true);
      return;
    }
    const t = setTimeout(() => setMounted(false), ms);
    return () => clearTimeout(t);
  }, [open, ms]);
  return { mounted: mounted || open, closing: !open && mounted };
}

/** Escape closes it; a press outside `ref` does too, when given one. */
function useDismiss(open: boolean, onClose: () => void, ref?: RefObject<HTMLElement | null>) {
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && close.current();
    const onDown = (e: PointerEvent) => {
      if (ref?.current && !ref.current.contains(e.target as Node)) close.current();
    };
    document.addEventListener("keydown", onKey);
    if (ref) document.addEventListener("pointerdown", onDown);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onDown);
    };
  }, [open, ref]);
}

export function WalletButton({ wallet, onOpen }: { wallet: WalletState; onOpen: () => void }) {
  const [menu, setMenu] = useState(false);
  const [copied, setCopied] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const { mounted, closing } = usePresence(menu, 160);
  useDismiss(menu, () => setMenu(false), box);

  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1400);
    return () => clearTimeout(t);
  }, [copied]);

  if (!wallet.address) {
    return (
      <button type="button" className="site-connect" onClick={onOpen}>
        Connect wallet
      </button>
    );
  }
  const address = wallet.address;
  const short = `${address.slice(0, 6)}...${address.slice(-4)}`;
  return (
    <div className="site-account-box" ref={box}>
      <button type="button" className="site-account" aria-haspopup="menu" aria-expanded={menu} onClick={() => setMenu((m) => !m)}>
        <WalletIcon wallet={wallet.active} size={20} />
        <span>{short}</span>
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden className={menu ? "site-caret site-caret-open" : "site-caret"}>
          <path d="m4 6 4 4 4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {mounted ? (
        <div className={closing ? "site-menu site-closing" : "site-menu"} role="menu">
          <div className="site-menu-head">
            <WalletIcon wallet={wallet.active} size={32} />
            <span>
              <strong>{wallet.active?.info.name ?? "Wallet"}</strong>
              <span className="site-mono">{short}</span>
            </span>
          </div>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              void navigator.clipboard?.writeText(address).then(() => setCopied(true), () => undefined);
            }}
          >
            {copied ? "Copied" : "Copy address"}
          </button>
          <a role="menuitem" href={`https://blockscout.injective.network/address/${address}`} target="_blank" rel="noreferrer" onClick={() => setMenu(false)}>
            View on explorer
          </a>
          <button
            type="button"
            role="menuitem"
            className="site-menu-danger"
            onClick={() => {
              setMenu(false);
              wallet.disconnect();
            }}
          >
            Disconnect
          </button>
        </div>
      ) : null}
    </div>
  );
}

function WalletIcon({ wallet, size }: { wallet: FoundWallet | null; size: number }) {
  if (wallet?.info.icon) return <img src={wallet.info.icon} alt="" width={size} height={size} className="site-wallet-icon" />;
  return (
    <span className="site-wallet-icon site-wallet-blank" style={{ width: size, height: size }} aria-hidden>
      <svg width={size * 0.55} height={size * 0.55} viewBox="0 0 16 16" fill="none">
        <path
          d="M12.5 5.25V4a1.25 1.25 0 0 0-1.25-1.25H4A1.75 1.75 0 0 0 2.25 4.5v7A1.75 1.75 0 0 0 4 13.25h8.5a1.25 1.25 0 0 0 1.25-1.25V6.5a1.25 1.25 0 0 0-1.25-1.25H4"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
        />
      </svg>
    </span>
  );
}

export function Modal({ open, onClose, title, children }: { open: boolean; onClose: () => void; title: string; children: ReactNode }) {
  const { mounted, closing } = usePresence(open);
  const panel = useRef<HTMLDivElement>(null);
  useDismiss(open, onClose);
  useEffect(() => {
    if (!open) return;
    const opener = document.activeElement as HTMLElement | null;
    panel.current?.focus();
    const { overflow } = document.body.style;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = overflow;
      opener?.focus?.();
    };
  }, [open]);
  if (!mounted) return null;
  return (
    <div className={closing ? "site-overlay site-closing" : "site-overlay"}>
      <div className="site-backdrop" onClick={onClose} />
      <div className="site-modal" role="dialog" aria-modal="true" aria-label={title} tabIndex={-1} ref={panel}>
        <div className="site-modal-head">
          <strong>{title}</strong>
          <button type="button" className="site-icon-btn" onClick={onClose} aria-label="Close">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden>
              <path d="m4 4 8 8m0-8-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

export function WalletPicker({ open, wallet, onClose }: { open: boolean; wallet: WalletState; onClose: () => void }) {
  const [connecting, setConnecting] = useState<string | null>(null);
  const last = lastWallet();
  useEffect(() => {
    if (!open) setConnecting(null);
  }, [open]);

  return (
    <Modal open={open} onClose={onClose} title="Connect a wallet">
      {wallet.wallets.length === 0 ? (
        <div className="site-nowallet">
          <p className="site-muted">No browser wallet found on this device. Install one, then reload this page.</p>
          <div className="site-install">
            <a href="https://metamask.io" target="_blank" rel="noreferrer">
              MetaMask
            </a>
            <a href="https://rabby.io" target="_blank" rel="noreferrer">
              Rabby
            </a>
            <a href="https://www.keplr.app" target="_blank" rel="noreferrer">
              Keplr
            </a>
          </div>
        </div>
      ) : (
        <>
          <p className="site-muted site-modal-sub">Pick the wallet that holds your USDC.</p>
          <ul className="site-wallets">
            {wallet.wallets.map((w, i) => (
              <li key={w.info.uuid} style={{ animationDelay: `${60 + i * 35}ms` }}>
                <button
                  type="button"
                  disabled={connecting !== null}
                  onClick={() => {
                    setConnecting(w.info.uuid);
                    void wallet.connect(w).finally(() => setConnecting(null));
                  }}
                >
                  <WalletIcon wallet={w} size={36} />
                  <span className="site-wallet-name">
                    {w.info.name}
                    {w.info.rdns === last ? <span className="site-tag">Last used</span> : null}
                  </span>
                  {connecting === w.info.uuid ? (
                    <span className="site-spinner" aria-label="Waiting for the wallet" />
                  ) : (
                    <svg className="site-go" width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden>
                      <path d="m6 4 4 4-4 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  )}
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
      {wallet.error ? <p className="site-error">{wallet.error}</p> : null}
    </Modal>
  );
}

import { type ReactNode, type RefObject, useEffect, useRef, useState } from "react";
import { ChainLogo } from "injective-usdc-bridge/react";
import { encode } from "uqr";
import { type SolanaWalletState, lastSolanaWallet } from "./solanaWallets";
import { WC_WALLETS } from "./walletConnect";
import { type WalletState, lastWallet } from "./wallets";

export type WalletKind = "evm" | "solana";

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

const short = (a: string) => `${a.slice(0, a.startsWith("0x") ? 6 : 4)}...${a.slice(-4)}`;

/** The header's wallet controls: one chip per connected wallet, or a connect button. */
export function WalletButtons({ evm, solana, onOpen }: { evm: WalletState; solana: SolanaWalletState; onOpen: (kind: WalletKind) => void }) {
  return (
    <div className="site-wallet-bar">
      {solana.address ? (
        <AccountChip
          kind="solana"
          name={solana.active?.name ?? "Solana wallet"}
          icon={solana.active?.icon ?? ""}
          address={solana.address}
          explorer={`https://solscan.io/account/${solana.address}`}
          onDisconnect={solana.disconnect}
        />
      ) : null}
      {evm.address ? (
        <AccountChip
          kind="evm"
          name={evm.active?.info.name ?? "Wallet"}
          icon={evm.active?.info.icon ?? ""}
          address={evm.address}
          explorer={`https://blockscout.injective.network/address/${evm.address}`}
          onDisconnect={evm.disconnect}
        />
      ) : (
        <button type="button" className="site-connect" aria-label="Connect Wallet" onClick={() => onOpen("evm")}>
          <span>
            Connect<span className="site-connect-more"> Wallet</span>
          </span>
        </button>
      )}
    </div>
  );
}

function AccountChip({
  kind,
  name,
  icon,
  address,
  explorer,
  onDisconnect,
}: {
  kind: WalletKind;
  name: string;
  icon: string;
  address: string;
  explorer: string;
  onDisconnect: () => void;
}) {
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

  const label = kind === "solana" ? `Solana wallet ${short(address)}` : `Wallet ${short(address)}`;
  return (
    <div className={`site-account-box site-account-${kind}`} ref={box}>
      <button type="button" className="site-account" aria-haspopup="menu" aria-expanded={menu} aria-label={label} onClick={() => setMenu((m) => !m)}>
        <WalletIcon icon={icon} size={20} kind={kind} />
        <span className="site-account-address">{short(address)}</span>
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden className={menu ? "site-caret site-caret-open" : "site-caret"}>
          <path d="m4 6 4 4 4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {mounted ? (
        <div className={closing ? "site-menu site-closing" : "site-menu"} role="menu">
          <div className="site-menu-head">
            <WalletIcon icon={icon} size={32} kind={kind} />
            <span>
              <strong>{name}</strong>
              <span className="site-mono">{short(address)}</span>
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
          <a role="menuitem" href={explorer} target="_blank" rel="noreferrer" onClick={() => setMenu(false)}>
            View on explorer
          </a>
          <button
            type="button"
            role="menuitem"
            className="site-menu-danger"
            onClick={() => {
              setMenu(false);
              onDisconnect();
            }}
          >
            Disconnect
          </button>
        </div>
      ) : null}
    </div>
  );
}

/** A wallet's own icon, with a small chain mark on Solana wallets. */
function WalletIcon({ icon, size, kind = "evm" }: { icon: string; size: number; kind?: WalletKind }) {
  const face = icon ? (
    <img src={icon} alt="" width={size} height={size} className="site-wallet-icon" />
  ) : (
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
  if (kind !== "solana") return face;
  return (
    <span className="site-wallet-with-chain" style={{ width: size, height: size }}>
      {face}
      <span className="site-wallet-chain">
        <ChainLogo chain="solana" name="Solana" size={Math.max(10, Math.round(size * 0.5))} />
      </span>
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

interface Choice {
  id: string;
  name: string;
  icon: string;
  last: boolean;
  sub?: string;
  connect: () => Promise<void>;
}

/** A phone with a QR code: WalletConnect's own mark is the partner's to use, not ours. */
const WC_ICON = `data:image/svg+xml,${encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 36 36"><rect width="36" height="36" rx="10" fill="#1b1e27"/><rect x="11" y="6.5" width="14" height="23" rx="3" fill="none" stroke="#e8eaf0" stroke-width="1.6"/><path d="M14.5 11h3v3h-3zM18.5 11h3v3h-3zM14.5 15h3v3h-3zM19.5 16h2v2h-2zM16.5 19h2v2h-2z" fill="#fdc70c"/><path d="M16 25.5h4" stroke="#e8eaf0" stroke-width="1.6" stroke-linecap="round"/></svg>',
)}`;

/** A WalletConnect pairing: links into phone wallets, a QR code to scan, the raw link to copy. */
function WcPairing({ uri, onBack }: { uri: string; onBack: () => void }) {
  const [copied, setCopied] = useState(false);
  const touch = typeof window.matchMedia === "function" && window.matchMedia("(pointer: coarse)").matches;
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1400);
    return () => clearTimeout(t);
  }, [copied]);
  return (
    <div className="site-wc">
      {touch ? (
        <>
          <p className="site-muted site-modal-sub">Open it in your wallet app, then come back here.</p>
          <ul className="site-wallets">
            {[...WC_WALLETS.map((w) => ({ name: w.name, href: w.link(uri) })), { name: "Another wallet", href: uri }].map((w, i) => (
              <li key={w.name} style={{ animationDelay: `${60 + i * 35}ms` }}>
                <a href={w.href} rel="noreferrer">
                  <span className="site-wallet-name">{w.name}</span>
                  <svg className="site-go" width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden>
                    <path d="m6 4 4 4-4 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </a>
              </li>
            ))}
          </ul>
        </>
      ) : null}
      <p className="site-muted site-modal-sub site-wc-scan">{touch ? "Or scan it from another device:" : "Scan this with your phone's wallet app."}</p>
      <div className="site-qr">
        <Qr text={uri} />
      </div>
      <div className="site-wc-actions">
        <button
          type="button"
          onClick={() => {
            void navigator.clipboard?.writeText(uri).then(() => setCopied(true), () => undefined);
          }}
        >
          {copied ? "Copied" : "Copy link"}
        </button>
        <button type="button" onClick={onBack}>
          Back
        </button>
      </div>
    </div>
  );
}

function Qr({ text }: { text: string }) {
  const { data, size } = encode(text, { ecc: "M", border: 2 });
  let d = "";
  data.forEach((row, y) =>
    row.forEach((dark, x) => {
      if (dark) d += `M${x} ${y}h1v1h-1z`;
    }),
  );
  return (
    <svg viewBox={`0 0 ${size} ${size}`} width="100%" height="100%" shapeRendering="crispEdges" role="img" aria-label="WalletConnect QR code">
      <rect width={size} height={size} fill="#fff" />
      <path d={d} fill="#0b0d12" />
    </svg>
  );
}

export function WalletPicker({
  open,
  kind,
  onKind,
  evm,
  solana,
  onClose,
}: {
  open: boolean;
  kind: WalletKind;
  onKind: (k: WalletKind) => void;
  evm: WalletState;
  solana: SolanaWalletState;
  onClose: () => void;
}) {
  const [connecting, setConnecting] = useState<string | null>(null);
  useEffect(() => {
    if (!open) setConnecting(null);
  }, [open]);

  const lastEvm = lastWallet();
  const lastSol = lastSolanaWallet();
  const wc = kind === "evm" ? evm.walletConnect : null;
  const browser: Choice[] =
    kind === "evm"
      ? evm.wallets.map((w) => ({ id: w.info.uuid, name: w.info.name, icon: w.info.icon, last: w.info.rdns === lastEvm, connect: () => evm.connect(w) }))
      : solana.wallets.map((w) => ({ id: `sol:${w.name}`, name: w.name, icon: w.icon, last: w.name === lastSol, connect: () => solana.connect(w) }));
  const choices: Choice[] = wc
    ? [...browser, { id: "walletconnect", name: "WalletConnect", icon: WC_ICON, last: lastEvm === "walletconnect", sub: "Phone wallets, by QR code", connect: wc.connect }]
    : browser;
  const close = () => {
    wc?.cancel();
    onClose();
  };

  return (
    <Modal open={open} onClose={close} title="Connect a wallet">
      <div className="site-kind" role="tablist" data-active={kind === "evm" ? "0" : "1"}>
        <span className="site-kind-indicator" aria-hidden />
        <button type="button" role="tab" aria-selected={kind === "evm"} onClick={() => onKind("evm")}>
          <ChainLogo chain="injective" name="Injective" size={18} /> Injective & EVM
        </button>
        <button type="button" role="tab" aria-selected={kind === "solana"} onClick={() => onKind("solana")}>
          <ChainLogo chain="solana" name="Solana" size={18} /> Solana
        </button>
      </div>
      {wc?.uri ? (
        <WcPairing uri={wc.uri} onBack={wc.cancel} />
      ) : choices.length === 0 ? (
        <div className="site-nowallet" key={kind}>
          <p className="site-muted">
            No {kind === "solana" ? "Solana" : "browser"} wallet found on this device. Install one, then reload this page.
          </p>
          <div className="site-install">
            {(kind === "solana"
              ? [
                  ["Phantom", "https://phantom.com"],
                  ["Solflare", "https://solflare.com"],
                  ["Backpack", "https://backpack.app"],
                ]
              : [
                  ["MetaMask", "https://metamask.io"],
                  ["Rabby", "https://rabby.io"],
                  ["Keplr", "https://www.keplr.app"],
                ]
            ).map(([name, url]) => (
              <a key={name} href={url} target="_blank" rel="noreferrer">
                {name}
              </a>
            ))}
          </div>
        </div>
      ) : (
        <>
          <p className="site-muted site-modal-sub">
            {kind === "solana"
              ? "To bridge from Solana, or to receive there."
              : browser.length === 0
                ? "No browser wallet on this device. Connect a phone wallet instead."
                : "Pick the wallet that holds your USDC."}
          </p>
          <ul className="site-wallets" key={kind}>
            {choices.map((w, i) => (
              <li key={w.id} style={{ animationDelay: `${60 + i * 35}ms` }}>
                <button
                  type="button"
                  disabled={connecting !== null}
                  onClick={() => {
                    setConnecting(w.id);
                    void w.connect().finally(() => setConnecting(null));
                  }}
                >
                  <WalletIcon icon={w.icon} size={36} />
                  <span className="site-wallet-name">
                    <span className="site-wallet-label">
                      {w.name}
                      {w.sub ? <span className="site-wallet-sub">{w.sub}</span> : null}
                    </span>
                    {w.last ? <span className="site-tag">Last used</span> : null}
                  </span>
                  {connecting === w.id ? (
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
    </Modal>
  );
}

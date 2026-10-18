import { type CSSProperties, type ReactNode, useEffect, useState } from "react";
import { ChainLogo } from "./ChainLogo.js";
import { shortAddress } from "./format.js";
import { IconCheck } from "./icons.js";
import { Sheet } from "./Sheet.js";
import { type SolanaWalletState, type StandardWallet, lastSolanaWallet, useSolanaWallet } from "./solanaWallets.js";
import type { SolanaWallet } from "./types.js";

const INSTALL = [
  ["Phantom", "https://phantom.com"],
  ["Solflare", "https://solflare.com"],
  ["Backpack", "https://backpack.app"],
] as const;

export interface SolanaWiring {
  solanaWallet: SolanaWallet | null;
  onConnectSolanaWallet: (() => void) | undefined;
  /** The picker sheet and, once connected, the account line. Null unless the widget connects Solana itself. */
  ui: ReactNode;
}

/**
 * The Solana wallet the widget works with: the host's when it passes one (or
 * passes `solanaWallet={null}` to say it has none), otherwise, with
 * `builtInSolanaWallet`, one the widget finds and connects itself. Built in,
 * it brings its own picker sheet and a line for switching or disconnecting.
 */
export function useSolanaWiring(p: {
  solanaWallet?: SolanaWallet | null | undefined;
  onConnectSolanaWallet?: (() => void) | undefined;
  builtInSolanaWallet?: boolean | undefined;
}): SolanaWiring {
  const builtIn = p.builtInSolanaWallet === true && p.solanaWallet === undefined;
  const state = useSolanaWallet({ enabled: builtIn });
  const [open, setOpen] = useState(false);
  // Close once a wallet connects from the sheet.
  useEffect(() => {
    if (state.address) setOpen(false);
  }, [state.address]);

  if (!builtIn) return { solanaWallet: p.solanaWallet ?? null, onConnectSolanaWallet: p.onConnectSolanaWallet, ui: null };
  return {
    solanaWallet: state.bridgeWallet,
    onConnectSolanaWallet: () => setOpen(true),
    ui: (
      <>
        {state.address ? <SolanaAccount state={state} onManage={() => setOpen(true)} /> : null}
        <SolanaPicker open={open} state={state} onClose={() => setOpen(false)} />
      </>
    ),
  };
}

/** One quiet line under the form: which Solana wallet is connected, and a way to change it. */
function SolanaAccount({ state, onManage }: { state: SolanaWalletState; onManage: () => void }) {
  return (
    <div className="iub-solaccount">
      <WalletFace wallet={state.active} size={18} />
      <span className="iub-muted">
        {state.active?.name ?? "Solana wallet"} <span className="iub-mono">{shortAddress(state.address!)}</span>
      </span>
      <button type="button" className="iub-link" onClick={onManage}>
        Change
      </button>
    </div>
  );
}

function SolanaPicker({ open, state, onClose }: { open: boolean; state: SolanaWalletState; onClose: () => void }) {
  const [connecting, setConnecting] = useState<string | null>(null);
  const last = lastSolanaWallet();
  return (
    <Sheet open={open} onClose={onClose} title="Connect a Solana wallet">
      <div className="iub-picker">
        {state.wallets.length === 0 ? (
          <div className="iub-picker-empty">
            No Solana wallet found in this browser. Install one, then reload the page.
            <div className="iub-install">
              {INSTALL.map(([name, url]) => (
                <a key={name} className="iub-action" href={url} target="_blank" rel="noreferrer">
                  {name}
                </a>
              ))}
            </div>
          </div>
        ) : (
          <ul className="iub-chains">
            {state.wallets.map((w, i) => {
              const current = state.active === w;
              return (
                <li key={w.name} style={{ "--i": i } as CSSProperties}>
                  <button
                    type="button"
                    aria-current={current}
                    disabled={connecting !== null}
                    onClick={() => {
                      if (current) return onClose();
                      setConnecting(w.name);
                      void state.connect(w).finally(() => setConnecting(null));
                    }}
                  >
                    <WalletFace wallet={w} size={34} />
                    <span className="iub-chains-text">
                      <span className="iub-chains-name">{w.name}</span>
                      <span className="iub-chains-sub">
                        {current ? shortAddress(state.address ?? "") : connecting === w.name ? "Confirm in the wallet" : w.name === last ? "Last used" : "Solana"}
                      </span>
                    </span>
                    <span className="iub-chains-check" aria-hidden>
                      {current ? <IconCheck /> : null}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
        {state.address ? (
          <button
            type="button"
            className="iub-action iub-disconnect"
            onClick={() => {
              state.disconnect();
              onClose();
            }}
          >
            Disconnect {shortAddress(state.address)}
          </button>
        ) : null}
      </div>
    </Sheet>
  );
}

/** The wallet's own icon with a small Solana mark; a plain Solana mark when there is none. */
function WalletFace({ wallet, size }: { wallet: StandardWallet | null; size: number }) {
  if (!wallet?.icon) return <ChainLogo chain="solana" name="Solana" size={size} />;
  return (
    <span className="iub-wallet-face" style={{ width: size, height: size }}>
      <img src={wallet.icon} alt="" width={size} height={size} />
      <span className="iub-wallet-face-chain">
        <ChainLogo chain="solana" name="Solana" size={Math.max(10, Math.round(size * 0.45))} />
      </span>
    </span>
  );
}

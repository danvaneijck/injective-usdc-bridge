import "@fontsource-variable/montserrat/wght.css";
import "injective-usdc-bridge/react/styles.css";
import "./site.css";
import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { Bridge, TransferStatus } from "injective-usdc-bridge/react";
import { type WalletState, useWallet } from "./wallets";

/** The built site is served by the bridge service, so the API is this origin. */
const API_URL = import.meta.env.VITE_API_URL ?? "";

function txRoute(path: string): { domain: number; txHash: string } | null {
  const m = /^\/tx\/(\d+)\/(0x[0-9a-fA-F]{64})\/?$/.exec(path);
  return m ? { domain: Number(m[1]), txHash: m[2]! } : null;
}

function App() {
  const wallet = useWallet();
  const [picking, setPicking] = useState(false);
  const track = txRoute(window.location.pathname);
  const bridgeWallet = { address: wallet.address, provider: wallet.active?.provider ?? null };

  useEffect(() => {
    if (wallet.address) setPicking(false);
  }, [wallet.address]);

  return (
    <div className="site">
      <header className="site-head">
        <a className="site-brand" href="/">
          <img src="/choice-logo.svg" alt="" width={28} height={28} />
          <span>
            Choice <strong>Bridge</strong>
          </span>
        </a>
        <WalletButton wallet={wallet} onOpen={() => setPicking(true)} />
      </header>

      <main className="site-main">
        <div className="site-intro">
          <h1>{track ? "Transfer status" : "Bridge USDC to and from Injective"}</h1>
          <p>
            {track
              ? "Live from the chains. Bookmark this page to check on it later."
              : "Native USDC over Circle CCTP. Every transfer is tracked until it lands, and deliveries are done for you."}
          </p>
        </div>
        {track ? (
          <>
            <TransferStatus apiUrl={API_URL} domain={track.domain} txHash={track.txHash} wallet={bridgeWallet} onConnectWallet={() => setPicking(true)} />
            <a className="site-new" href="/">
              Start a new transfer
            </a>
          </>
        ) : (
          <Bridge apiUrl={API_URL} wallet={bridgeWallet} onConnectWallet={() => setPicking(true)} />
        )}
      </main>

      <footer className="site-foot">
        <span>Powered by Circle CCTP</span>
        <a href="https://github.com/danvaneijck/injective-usdc-bridge" target="_blank" rel="noreferrer">
          Source
        </a>
        <a href={`${API_URL}/v1/health`} target="_blank" rel="noreferrer">
          Status
        </a>
        <a href="https://choice.exchange" target="_blank" rel="noreferrer">
          choice.exchange
        </a>
      </footer>

      {picking ? <WalletPicker wallet={wallet} onClose={() => setPicking(false)} /> : null}
    </div>
  );
}

function WalletButton({ wallet, onOpen }: { wallet: WalletState; onOpen: () => void }) {
  if (!wallet.address) {
    return (
      <button type="button" className="site-connect" onClick={onOpen}>
        Connect wallet
      </button>
    );
  }
  return (
    <button type="button" className="site-account" onClick={wallet.disconnect} title="Disconnect">
      {wallet.active?.info.icon ? <img src={wallet.active.info.icon} alt="" width={18} height={18} /> : null}
      {wallet.address.slice(0, 6)}...{wallet.address.slice(-4)}
    </button>
  );
}

function WalletPicker({ wallet, onClose }: { wallet: WalletState; onClose: () => void }) {
  return (
    <div className="site-overlay" role="dialog" aria-modal="true" aria-label="Connect a wallet" onClick={onClose}>
      <div className="site-modal" onClick={(e) => e.stopPropagation()}>
        <div className="site-modal-head">
          <strong>Connect a wallet</strong>
          <button type="button" onClick={onClose} aria-label="Close">
            Close
          </button>
        </div>
        {wallet.wallets.length === 0 ? (
          <p className="site-muted">
            No browser wallet found. Install{" "}
            <a href="https://metamask.io" target="_blank" rel="noreferrer">
              MetaMask
            </a>
            ,{" "}
            <a href="https://rabby.io" target="_blank" rel="noreferrer">
              Rabby
            </a>{" "}
            or{" "}
            <a href="https://www.keplr.app" target="_blank" rel="noreferrer">
              Keplr
            </a>
            , then reload.
          </p>
        ) : (
          <ul className="site-wallets">
            {wallet.wallets.map((w) => (
              <li key={w.info.uuid}>
                <button type="button" onClick={() => void wallet.connect(w)}>
                  {w.info.icon ? <img src={w.info.icon} alt="" width={28} height={28} /> : <span className="site-wallet-blank" />}
                  {w.info.name}
                </button>
              </li>
            ))}
          </ul>
        )}
        {wallet.error ? <p className="site-error">{wallet.error}</p> : null}
      </div>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

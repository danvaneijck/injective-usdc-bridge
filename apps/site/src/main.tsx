import "@fontsource-variable/montserrat/wght.css";
import "injective-usdc-bridge/react/styles.css";
import "./site.css";
import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { injective, peers } from "injective-usdc-bridge";
import { Bridge, ChainLogo, TransferStatus } from "injective-usdc-bridge/react";
import { Link, NavProvider, txRoute, usePath } from "./router";
import { StatusPage } from "./Status";
import { WalletButton, WalletPicker } from "./WalletUi";
import { useWallet } from "./wallets";

/** The built site is served by the bridge service, so the API is this origin. */
const API_URL = import.meta.env.VITE_API_URL ?? "";

/** Every chain the bridge reaches, Injective first. */
const CHAINS = [injective("mainnet"), ...peers("mainnet").filter((c) => c.kind === "evm")];

const TITLES = { bridge: "USDC Bridge | Choice", status: "Status | Choice Bridge", track: "Transfer | Choice Bridge" } as const;

function App() {
  const wallet = useWallet();
  const [path, go] = usePath();
  const [picking, setPicking] = useState(false);
  const track = txRoute(path);
  const page = track ? "track" : path.replace(/\/$/, "") === "/status" ? "status" : "bridge";
  const bridgeWallet = { address: wallet.address, provider: wallet.active?.provider ?? null };

  useEffect(() => {
    if (wallet.address) setPicking(false);
  }, [wallet.address]);
  useEffect(() => {
    document.title = TITLES[page];
  }, [page]);

  return (
    <NavProvider value={go}>
      <div className="site">
        <div className="site-glow" aria-hidden />
        <header className="site-head">
          <Link to="/" className="site-brand">
            <img src="/choice-logo.svg" alt="" width={30} height={30} />
            <span>
              Choice <strong>Bridge</strong>
            </span>
          </Link>
          <nav className="site-nav" aria-label="Main">
            <Link to="/" className="site-nav-link" aria-current={page !== "status" ? "page" : undefined}>
              Bridge
            </Link>
            <Link to="/status" className="site-nav-link" aria-current={page === "status" ? "page" : undefined}>
              Status
            </Link>
          </nav>
          <WalletButton wallet={wallet} onOpen={() => setPicking(true)} />
        </header>

        <main className="site-main" key={page}>
          {page === "status" ? (
            <>
              <div className="site-intro">
                <h1>Bridge status</h1>
                <p>Live from the bridge service: every chain it watches, and how deliveries are going.</p>
              </div>
              <StatusPage apiUrl={API_URL} />
            </>
          ) : track ? (
            <>
              <div className="site-intro">
                <h1>Transfer status</h1>
                <p>Live from the chains. Bookmark this page to check on it later.</p>
              </div>
              <TransferStatus apiUrl={API_URL} domain={track.domain} txHash={track.txHash} wallet={bridgeWallet} onConnectWallet={() => setPicking(true)} />
              <Link to="/" className="site-new">
                Start a new transfer
              </Link>
            </>
          ) : (
            <>
              <div className="site-intro">
                <h1>
                  Bridge USDC to and from <span className="site-hl">Injective</span>
                </h1>
                <p>Native USDC over Circle CCTP. Every transfer is tracked until it lands, and deliveries are done for you.</p>
                <ul className="site-chains" aria-label={`${CHAINS.length} chains`}>
                  {CHAINS.map((c, i) => (
                    <li key={c.key} title={c.name} style={{ animationDelay: `${120 + i * 25}ms` }}>
                      <ChainLogo chain={c.key} name={c.name} size={24} />
                    </li>
                  ))}
                </ul>
              </div>
              <Bridge apiUrl={API_URL} wallet={bridgeWallet} onConnectWallet={() => setPicking(true)} />
            </>
          )}
        </main>

        <footer className="site-foot">
          <span>Powered by Circle CCTP</span>
          <Link to="/status">Status</Link>
          <a href="https://github.com/danvaneijck/injective-usdc-bridge" target="_blank" rel="noreferrer">
            Source
          </a>
          <a href="https://choice.exchange" target="_blank" rel="noreferrer">
            choice.exchange
          </a>
        </footer>

        <WalletPicker open={picking} wallet={wallet} onClose={() => setPicking(false)} />
      </div>
    </NavProvider>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

import "@fontsource-variable/montserrat/wght.css";
import "injective-usdc-bridge/react/styles.css";
import "./site.css";
import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { Bridge, TransferStatus } from "injective-usdc-bridge/react";
import { Link, NavProvider, txRoute, usePath } from "./router";
import { useSolanaWallet } from "./solanaWallets";
import { StatusPage } from "./Status";
import { type WalletKind, WalletButtons, WalletPicker } from "./WalletUi";
import { useWallet } from "./wallets";

/** The built site is served by the bridge service, so the API is this origin. */
const API_URL = import.meta.env.VITE_API_URL ?? "";

const TITLES = { bridge: "USDC Bridge | Choice", status: "Status | Choice Bridge", track: "Transfer | Choice Bridge" } as const;

function App() {
  const wallet = useWallet();
  const solana = useSolanaWallet();
  const [path, go] = usePath();
  const [picking, setPicking] = useState<WalletKind | null>(null);
  const [kind, setKind] = useState<WalletKind>("evm");
  const openPicker = (k: WalletKind) => {
    setKind(k);
    setPicking(k);
  };
  const track = txRoute(path);
  const page = track ? "track" : path.replace(/\/$/, "") === "/status" ? "status" : "bridge";
  const bridgeWallet = { address: wallet.address, provider: wallet.active?.provider ?? null };

  // Close the picker once the wallet it was opened for connects.
  useEffect(() => {
    if (wallet.address) setPicking((p) => (p === "evm" ? null : p));
  }, [wallet.address]);
  useEffect(() => {
    if (solana.address) setPicking((p) => (p === "solana" ? null : p));
  }, [solana.address]);
  useEffect(() => {
    document.title = TITLES[page];
  }, [page]);

  return (
    <NavProvider value={go}>
      <div className="site">
        <header className="site-head">
          <Link to="/" className="site-brand">
            <img src="/choice-logo.svg" alt="" width={30} height={30} />
            <span>
              Choice <strong>Bridge</strong>
            </span>
          </Link>
          <WalletButtons evm={wallet} solana={solana} onOpen={openPicker} />
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
              <TransferStatus
                apiUrl={API_URL}
                domain={track.domain}
                txHash={track.txHash}
                wallet={bridgeWallet}
                onConnectWallet={() => openPicker("evm")}
                solanaWallet={solana.bridgeWallet}
                onConnectSolanaWallet={() => openPicker("solana")}
                tabTitle
              />
              <Link to="/" className="site-new">
                Start a new transfer
              </Link>
            </>
          ) : (
            <>
              {/* The form is the page: on a phone a headline above it pushed the
                  button a screen and a half down. The heading stays for screen
                  readers and search. */}
              <h1 className="site-sr">Bridge USDC to and from Injective</h1>
              <Bridge
                apiUrl={API_URL}
                wallet={bridgeWallet}
                onConnectWallet={() => openPicker("evm")}
                solanaWallet={solana.bridgeWallet}
                onConnectSolanaWallet={() => openPicker("solana")}
                tabTitle
              />
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

        <WalletPicker
          open={picking !== null}
          kind={kind}
          onKind={(k) => {
            setKind(k);
            setPicking(k);
          }}
          evm={wallet}
          solana={solana}
          onClose={() => setPicking(null)}
        />
      </div>
    </NavProvider>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

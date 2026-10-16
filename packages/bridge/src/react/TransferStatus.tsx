import { useState } from "react";
import { type Address, type Hex, getAddress } from "viem";
import { chainByDomain, explorerTxUrl } from "../chains.js";
import { USDC_DECIMALS } from "../constants.js";
import type { TransferView } from "./api.js";
import { ChainLogo } from "./ChainLogo.js";
import { formatAmount, shortAddress } from "./format.js";
import { type Env, useEnv, useNow, usePoll } from "./hooks.js";
import { IconAlert, IconBack, IconCheck, IconExternal, Spinner } from "./icons.js";
import { type Step, progressOf } from "./progress.js";
import type { BridgeWallet } from "./types.js";
import { friendlyError, sendCall } from "./wallet.js";

export interface TransferStatusProps {
  /** CCTP domain of the source chain. */
  domain: number;
  txHash: string;
  wallet?: BridgeWallet;
  onConnectWallet?: () => void;
  network?: TransferStatusEnvProps["network"];
  apiUrl?: string;
  rpcUrls?: Partial<Record<string, string[]>>;
  className?: string;
}

type TransferStatusEnvProps = Parameters<typeof useEnv>[0];

/** A standalone tracking card for one source transaction, e.g. a /tx page. */
export function TransferStatus(props: TransferStatusProps) {
  const env = useEnv(props);
  return (
    <div className={`iub ${props.className ?? ""}`}>
      <TransferTracker env={env} domain={props.domain} txHash={props.txHash} wallet={props.wallet} onConnectWallet={props.onConnectWallet} />
    </div>
  );
}

export function TransferTracker({
  env,
  domain,
  txHash,
  wallet,
  onConnectWallet,
  onBack,
}: {
  env: Env;
  domain: number;
  txHash: string;
  wallet?: BridgeWallet | undefined;
  onConnectWallet?: (() => void) | undefined;
  onBack?: () => void;
}) {
  const { data, refresh } = usePoll(`tx:${domain}:${txHash}`, () => env.api.transfer(domain, txHash), 4_000);
  const now = useNow();
  const src = chainByDomain(env.network, domain);

  return (
    <div className="iub-body">
      {onBack ? (
        <button type="button" className="iub-back" onClick={onBack}>
          <IconBack /> Back
        </button>
      ) : null}
      {data && data.length > 0 ? (
        data.map((v) => <TransferCard key={v.id} env={env} view={v} now={now} wallet={wallet} onConnectWallet={onConnectWallet} onClaimed={refresh} />)
      ) : (
        <div className="iub-card">
          <div className="iub-card-head">
            <span className="iub-pill iub-pill-progress">
              <Spinner /> Confirming
            </span>
          </div>
          <Steps
            steps={[
              {
                label: `Confirming on ${src?.name ?? "the source chain"}`,
                detail: "Waiting for the transaction to be included",
                state: "active",
                link: src ? explorerTxUrl(src, txHash) : null,
              },
              { label: "Circle approval", detail: null, state: "waiting", link: null },
              { label: "Arrives", detail: null, state: "waiting", link: null },
            ]}
          />
        </div>
      )}
    </div>
  );
}

function TransferCard({
  env,
  view,
  now,
  wallet,
  onConnectWallet,
  onClaimed,
}: {
  env: Env;
  view: TransferView;
  now: number;
  wallet?: BridgeWallet | undefined;
  onConnectWallet?: (() => void) | undefined;
  onClaimed: () => void;
}) {
  const p = progressOf(view, now);
  const [claiming, setClaiming] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function claim() {
    const c = view.claim;
    const chain = c ? env.chainById(c.chainId) : undefined;
    if (!c || !chain || !wallet?.provider || !wallet.address) return;
    setClaiming(true);
    setError(null);
    try {
      const client = env.clientFor(chain);
      const hash = await sendCall(wallet.provider, getAddress(wallet.address) as Address, chain, client, { to: c.to as Address, data: c.data as Hex });
      await client.waitForTransactionReceipt({ hash, timeout: 180_000 });
      onClaimed();
    } catch (e) {
      setError(friendlyError(e));
    } finally {
      setClaiming(false);
    }
  }

  return (
    <div className="iub-card">
      <div className="iub-card-head">
        <div className="iub-route">
          <ChainLogo chain={view.source.chain} name={view.source.name} size={22} />
          <span className="iub-route-arrow">to</span>
          <ChainLogo chain={view.destination.chain} name={view.destination.name} size={22} />
          <strong>{formatAmount(BigInt(view.amount), USDC_DECIMALS, 2)} USDC</strong>
        </div>
        <span className={`iub-pill iub-pill-${p.tone}`}>
          {p.tone === "progress" ? <Spinner /> : p.tone === "done" ? <IconCheck /> : <IconAlert />}
          {p.headline}
        </span>
      </div>
      <Steps steps={p.steps} />
      <div className="iub-card-foot iub-muted">To {shortAddress(view.recipient)}</div>
      {p.canClaim ? (
        <div className="iub-claim">
          <p className="iub-muted">
            {view.direction === "withdraw" && view.kind !== "forward"
              ? `Approved. Send one transaction on ${view.destination.name} to receive it.`
              : "Approved but not delivered yet. You can finish it yourself with one transaction."}
          </p>
          {wallet?.address && wallet.provider ? (
            <button type="button" className="iub-primary" disabled={claiming} onClick={() => void claim()}>
              {claiming ? <Spinner /> : null}
              {claiming ? "Confirm in your wallet" : `Complete on ${view.destination.name}`}
            </button>
          ) : (
            <button type="button" className="iub-primary" disabled={!onConnectWallet} onClick={onConnectWallet}>
              Connect a wallet to complete it
            </button>
          )}
          {error ? <div className="iub-note iub-note-error">{error}</div> : null}
        </div>
      ) : null}
    </div>
  );
}

function Steps({ steps }: { steps: Step[] }) {
  return (
    <ol className="iub-steps">
      {steps.map((s, i) => (
        <li key={i} className={`iub-step iub-step-${s.state}`}>
          <span className="iub-step-dot">{s.state === "done" ? <IconCheck /> : s.state === "problem" ? <IconAlert /> : i + 1}</span>
          <span className="iub-step-text">
            <span className="iub-step-label">
              {s.label}
              {s.link ? (
                <a href={s.link} target="_blank" rel="noreferrer" className="iub-ext" aria-label="View on explorer">
                  <IconExternal />
                </a>
              ) : null}
            </span>
            {s.detail ? <span className="iub-step-detail">{s.detail}</span> : null}
          </span>
        </li>
      ))}
    </ol>
  );
}

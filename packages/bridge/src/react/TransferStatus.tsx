import { useEffect, useState } from "react";
import { type Address, type Hex, getAddress } from "viem";
import { chainByDomain, explorerTxUrl } from "../chains.js";
import { USDC_DECIMALS } from "../constants.js";
import type { TransferView } from "./api.js";
import { ChainLogo, ChainPair } from "./ChainLogo.js";
import { formatAmount, formatDuration, formatUsdc, shortAddress } from "./format.js";
import { type Env, useEnv, useNow, usePoll } from "./hooks.js";
import { IconAlert, IconArrow, IconBack, IconCheck, IconCopy, IconExternal, IconSuccess, PulseDot, Spinner } from "./icons.js";
import { type Progress, type Step, progressOf } from "./progress.js";
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
      <div className="iub-view">
        <TransferTracker env={env} domain={props.domain} txHash={props.txHash} wallet={props.wallet} onConnectWallet={props.onConnectWallet} />
      </div>
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
            <span className="iub-pair" style={{ width: 51, height: 32 }}>
              <ChainLogo chain={src?.key ?? null} name={src?.name ?? "?"} size={32} />
            </span>
            <span className="iub-card-title">
              <strong>Sent from {src?.name ?? "the source chain"}</strong>
              <span className="iub-muted">Waiting for the transaction to be included</span>
            </span>
            <StatusPill tone="progress" headline="Confirming" />
          </div>
          <Bar pct={0.08} tone="progress" />
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

export function StatusPill({ tone, headline }: { tone: Progress["tone"]; headline: string }) {
  return (
    <span className={`iub-pill iub-pill-${tone}`}>
      {tone === "progress" ? <PulseDot /> : tone === "done" ? <IconCheck /> : <IconAlert />}
      {headline}
    </span>
  );
}

/** How far along it is: each step a third, Circle's step by its usual time. */
function progressFraction(v: TransferView, p: Progress, now: number): number {
  if (v.phase === "delivered") return 1;
  const done = p.steps.filter((s) => s.state === "done").length;
  let part = 0;
  if (v.phase === "attesting" || v.phase === "not_found") {
    const sent = v.source.time ? Date.parse(v.source.time) : now;
    part = Math.min(0.92, (now - sent) / Math.max(1, v.expectedAttestSec * 1000));
  } else if (v.phase === "ready") {
    part = 0.5;
  }
  return Math.min(0.97, (done + part) / 3);
}

function Bar({ pct, tone }: { pct: number; tone: Progress["tone"] }) {
  return (
    <div className={`iub-bar iub-bar-${tone}`} role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(pct * 100)}>
      <span style={{ width: `${Math.max(4, pct * 100)}%` }} />
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
  const sent = view.source.time ? Date.parse(view.source.time) : null;
  const took = view.deliveredAt && sent !== null ? Date.parse(view.deliveredAt) - sent : null;

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
    <div className={`iub-card iub-card-${p.tone}`}>
      <div className="iub-card-head">
        <ChainPair from={view.source} to={view.destination} size={32} />
        <span className="iub-card-title">
          <strong>{formatAmount(BigInt(view.amount), USDC_DECIMALS, 2)} USDC</strong>
          <span className="iub-muted iub-route-names">
            {view.source.name} <IconArrow /> {view.destination.name}
          </span>
        </span>
        <StatusPill tone={p.tone} headline={p.headline} />
      </div>

      {p.tone === "done" ? (
        <div className="iub-done">
          <IconSuccess />
          <span>
            <strong>Delivered on {view.destination.name}</strong>
            <span className="iub-muted">{took !== null && took > 0 ? `${formatDuration(took)} after it was sent` : "The USDC is in the wallet"}</span>
          </span>
        </div>
      ) : (
        <Bar pct={progressFraction(view, p, now)} tone={p.tone} />
      )}

      <Steps steps={p.steps} />

      <dl className="iub-facts">
        <div>
          <dt>Recipient</dt>
          <dd>
            <span className="iub-mono" title={view.recipient}>
              {shortAddress(view.recipient)}
            </span>
            <CopyButton value={view.recipient} label="Copy recipient address" />
          </dd>
        </div>
        <div>
          <dt>Sent</dt>
          <dd>
            <TxLink hash={view.source.txHash} url={view.source.txUrl} />
          </dd>
        </div>
        {view.destination.mintTx ? (
          <div>
            <dt>Delivered</dt>
            <dd>
              <TxLink hash={view.destination.mintTx} url={view.destination.mintTxUrl} />
            </dd>
          </div>
        ) : null}
        {view.feeExecuted && BigInt(view.feeExecuted) > 0n ? (
          <div>
            <dt>Circle fee</dt>
            <dd>{formatUsdc(BigInt(view.feeExecuted), 6)} USDC</dd>
          </div>
        ) : null}
      </dl>

      {p.canClaim ? (
        <div className="iub-claim">
          <p className="iub-muted">
            {view.direction === "withdraw" && view.kind !== "forward"
              ? `Approved. Send one transaction on ${view.destination.name} to receive it.`
              : "Approved but not delivered yet. You can finish it yourself with one transaction."}
          </p>
          {wallet?.address && wallet.provider ? (
            <button type="button" className={claiming ? "iub-primary iub-primary-busy" : "iub-primary"} disabled={claiming} onClick={() => void claim()}>
              {claiming ? <Spinner /> : null}
              {claiming ? "Confirm in your wallet" : `Complete on ${view.destination.name}`}
            </button>
          ) : (
            <button type="button" className="iub-primary" disabled={!onConnectWallet} onClick={onConnectWallet}>
              Connect a wallet to complete it
            </button>
          )}
          {error ? (
            <div className="iub-note iub-note-error" role="alert">
              <IconAlert />
              <span>{error}</span>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function TxLink({ hash, url }: { hash: string; url: string | null }) {
  const text = `${hash.slice(0, 8)}...${hash.slice(-6)}`;
  return url ? (
    <a className="iub-txlink iub-mono" href={url} target="_blank" rel="noreferrer">
      {text} <IconExternal />
    </a>
  ) : (
    <span className="iub-mono">{text}</span>
  );
}

function CopyButton({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(t);
  }, [copied]);
  return (
    <button
      type="button"
      className={copied ? "iub-copy iub-copied" : "iub-copy"}
      aria-label={copied ? "Copied" : label}
      title={copied ? "Copied" : "Copy"}
      onClick={() => {
        navigator.clipboard?.writeText(value).then(
          () => setCopied(true),
          () => undefined,
        );
      }}
    >
      {copied ? <IconCheck /> : <IconCopy />}
    </button>
  );
}

function Steps({ steps }: { steps: Step[] }) {
  return (
    <ol className="iub-steps">
      {steps.map((s, i) => (
        <li key={i} className={`iub-step iub-step-${s.state}`}>
          <span className="iub-step-dot" key={s.state}>
            {s.state === "done" ? <IconCheck /> : s.state === "problem" ? <IconAlert /> : s.state === "active" ? <span className="iub-step-core" /> : i + 1}
          </span>
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

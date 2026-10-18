import { Component, type ReactNode, useEffect, useRef, useState } from "react";
import { type Address, type Hex, getAddress } from "viem";
import { chainByDomain, explorerTxUrl } from "../chains.js";
import { FINALITY, USDC_DECIMALS } from "../constants.js";
import { bytes32ToSolana } from "../solana.js";
import type { TransferView } from "./api.js";
import { ChainLogo, ChainPair } from "./ChainLogo.js";
import { formatAmount, formatDuration, formatUsdc, shortAddress } from "./format.js";
import { type Env, useEnv, useNow, usePoll, useSolanaEventAccounts } from "./hooks.js";
import { IconAlert, IconArrow, IconBack, IconBell, IconCheck, IconCopy, IconExternal, IconInfo, IconSuccess, PulseDot, Spinner } from "./icons.js";
import { enableNotifications, notificationsOn, notificationsSupported, useTransferAlerts } from "./alerts.js";
import { type Progress, type Step, progressOf } from "./progress.js";
import { claimOnSolana, reclaimDeposit, refundState } from "./refunds.js";
import { useSolanaWiring } from "./BuiltInSolana.js";
import { DeliveryWatch } from "./delivered.js";
import type { BridgeWallet, SolanaWallet, WidgetCommonProps } from "./types.js";
import { friendlyError, sendCall } from "./wallet.js";
import { Toasts, showToast } from "./toast.js";

export interface TransferStatusProps extends WidgetCommonProps {
  /** CCTP domain of the source chain. */
  domain: number;
  txHash: string;
  wallet?: BridgeWallet;
  onConnectWallet?: () => void;
}

/** A standalone tracking card for one source transaction, e.g. a /tx page. */
export function TransferStatus(props: TransferStatusProps) {
  const env = useEnv(props);
  const solana = useSolanaWiring(props);
  const [watch] = useState(() => new DeliveryWatch());
  const onDelivered = useRef(props.onDelivered);
  onDelivered.current = props.onDelivered;
  return (
    <div className={rootClass(props)}>
      <Toasts />
      <div className="iub-view">
        <TransferTracker
          env={env}
          domain={props.domain}
          txHash={props.txHash}
          wallet={props.wallet}
          onConnectWallet={props.onConnectWallet}
          solanaWallet={solana.solanaWallet}
          onConnectSolanaWallet={solana.onConnectSolanaWallet}
          tabTitle={props.tabTitle}
          onViews={(views) => {
            for (const v of watch.update(views)) onDelivered.current?.(v);
          }}
        />
      </div>
      {solana.ui}
    </div>
  );
}

/** The widget's root class: its card unless the host asked for it bare. */
export function rootClass(p: { bare?: boolean | undefined; className?: string | undefined }): string {
  return ["iub", p.bare ? "iub-bare" : "", p.className ?? ""].filter(Boolean).join(" ");
}

interface Wallets {
  wallet?: BridgeWallet | undefined;
  onConnectWallet?: (() => void) | undefined;
  solanaWallet?: SolanaWallet | null | undefined;
  onConnectSolanaWallet?: (() => void) | undefined;
}

export function TransferTracker({
  env,
  domain,
  txHash,
  onBack,
  tabTitle,
  known,
  onViews,
  ...wallets
}: Wallets & {
  env: Env;
  domain: number;
  txHash: string;
  onBack?: () => void;
  tabTitle?: boolean | undefined;
  /** Views of this transaction the host already holds (Activity's rows): shown until the fresh answer lands. */
  known?: TransferView[] | undefined;
  /** Every fresh answer from the service. */
  onViews?: ((views: TransferView[]) => void) | undefined;
}) {
  const { data: fetched, error: fetchError, refresh } = usePoll(`tx:${domain}:${txHash}`, () => env.api.transfer(domain, txHash), 4_000);
  const onViewsRef = useRef(onViews);
  onViewsRef.current = onViews;
  useEffect(() => {
    if (fetched) onViewsRef.current?.(fetched);
  }, [fetched]);
  const data = fetched ?? (known && known.length > 0 ? known : null);
  const now = useNow();
  useTransferAlerts(data ?? [], { title: tabTitle === true });
  const src = chainByDomain(env.network, domain);
  // Only an ANSWER of "nothing yet" means it is still confirming. Before the
  // first answer the page knows nothing, and saying "Confirming" about a
  // transfer that finished last week is wrong.
  const answered = fetched !== null || fetchError !== null;

  return (
    <div className="iub-body">
      {onBack ? (
        <button type="button" className="iub-back" onClick={onBack}>
          <IconBack /> Back
        </button>
      ) : null}
      {data && data.length > 0 ? (
        data.map((v) => (
          <CardBoundary key={v.id} view={v}>
            <TransferCard env={env} view={v} now={now} {...wallets} onClaimed={refresh} />
          </CardBoundary>
        ))
      ) : !answered ? (
        <div className="iub-card" aria-busy="true">
          <div className="iub-card-head">
            <span className="iub-pair" style={{ width: 51, height: 32 }}>
              <ChainLogo chain={src?.key ?? null} name={src?.name ?? "?"} size={32} />
            </span>
            <span className="iub-card-title">
              <strong>Sent from {src?.name ?? "the source chain"}</strong>
              <span className="iub-muted">Looking it up</span>
            </span>
            <Spinner />
          </div>
        </div>
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

/**
 * One transfer the card cannot draw (an answer shaped in a way this widget
 * does not expect) costs that card, never the page around it.
 */
class CardBoundary extends Component<{ view: TransferView; children: ReactNode }, { failed: boolean }> {
  override state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  override render() {
    if (!this.state.failed) return this.props.children;
    const { source } = this.props.view;
    return (
      <div className="iub-card">
        <Note tone="error">This transfer could not be shown here. It is safe; check it on the explorer.</Note>
        <dl className="iub-facts">
          <div>
            <dt>Sent</dt>
            <dd>
              <TxLink hash={source.txHash} url={source.txUrl} />
            </dd>
          </div>
        </dl>
      </div>
    );
  }
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
  solanaWallet,
  onConnectSolanaWallet,
  onClaimed,
}: Wallets & {
  env: Env;
  view: TransferView;
  now: number;
  onClaimed: () => void;
}) {
  const p = progressOf(view, now);
  const [claiming, setClaiming] = useState(false);
  const sent = view.source.time ? Date.parse(view.source.time) : null;
  const took = view.deliveredAt && sent !== null ? Date.parse(view.deliveredAt) - sent : null;
  const onSolana = (view.solanaClaim ?? null) !== null;
  const events = useSolanaEventAccounts(env, view.solanaRefund ? [view.solanaRefund.eventAccount] : []);
  const refund = refundState(view, events.data, now);

  async function claim() {
    setClaiming(true);
    try {
      if (onSolana) {
        if (!solanaWallet) return;
        await claimOnSolana(env, solanaWallet, view);
      } else {
        const c = view.claim;
        const chain = c ? env.chainById(c.chainId) : undefined;
        if (!c || !chain || !wallet?.provider || !wallet.address) return;
        const client = env.clientFor(chain);
        const hash = await sendCall(wallet.provider, getAddress(wallet.address) as Address, chain, client, { to: c.to as Address, data: c.data as Hex });
        await client.waitForTransactionReceipt({ hash, timeout: 180_000 });
      }
      // The service would only notice on its next check, minutes away for an
      // older transfer; have it look now, so the card turns Delivered.
      await env.api.hint(view.source.domain, view.source.txHash);
      onClaimed();
    } catch (e) {
      showToast(friendlyError(e));
    } finally {
      setClaiming(false);
    }
  }
  const canSign = onSolana ? solanaWallet != null : Boolean(wallet?.address && wallet.provider);
  const receiver = receiverOf(view);
  const fee = feeLine(view);
  const connect = onSolana ? onConnectSolanaWallet : onConnectWallet;

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

      {p.tone === "progress" ? <NotifyMe claim={view.direction === "withdraw" && view.kind !== "forward"} /> : null}

      <dl className="iub-facts">
        {receiver ? (
          <div>
            <dt>{receiver.label}</dt>
            <dd>
              <span className="iub-mono" title={receiver.address}>
                {shortAddress(receiver.address)}
              </span>
              <CopyButton value={receiver.address} label={`Copy ${receiver.label.toLowerCase()} address`} />
            </dd>
          </div>
        ) : null}
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
        {fee ? (
          <div>
            <dt>{fee.label}</dt>
            <dd>{fee.value}</dd>
          </div>
        ) : null}
        {refund?.state === "waiting" || refund?.state === "refunded" ? (
          <div>
            <dt>SOL deposit</dt>
            <dd>{refund.state === "refunded" ? "Refunded" : `${formatSol(refund.lamports)} SOL, back from ${formatWhen(refund.availableAt)}`}</dd>
          </div>
        ) : null}
      </dl>

      {p.canClaim ? (
        <div className="iub-claim">
          {/* No sentence restating it: the steps above say it is approved, and
              the button says what pressing it does. */}
          {canSign ? (
            <button type="button" className={claiming ? "iub-primary iub-primary-busy" : "iub-primary"} disabled={claiming} onClick={() => void claim()}>
              {claiming ? <Spinner /> : null}
              {claiming ? "Confirm in your wallet" : `Complete on ${view.destination.name}`}
            </button>
          ) : connect ? (
            // A host with no wallet hook gets no button at all, never a dead one.
            <button type="button" className="iub-primary" onClick={connect}>
              {onSolana ? "Connect a Solana wallet to complete it" : "Connect a wallet to complete it"}
            </button>
          ) : null}
        </div>
      ) : null}

      {refund?.state === "ready" ? (
        <RefundAction
          env={env}
          view={view}
          lamports={refund.lamports}
          rentPayer={refund.rentPayer}
          solanaWallet={solanaWallet ?? null}
          onConnectSolanaWallet={onConnectSolanaWallet}
          onDone={events.refresh}
        />
      ) : null}
    </div>
  );
}

/**
 * Who receives, as far as the service knows: the wallet, or for a transfer to
 * Solana whose wallet is not read yet, the USDC account it names.
 */
export function receiverOf(view: TransferView): { label: string; address: string } | null {
  if (view.recipient) return { label: "Recipient", address: view.recipient };
  if (view.destination.chain === "solana" && view.mintRecipient) {
    try {
      return { label: "USDC account", address: bytes32ToSolana(view.mintRecipient as Hex) };
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * The fee Circle took, named as the form named it. A delivered withdrawal's
 * fee is mostly (from Injective, wholly) the delivery; Circle's own fee is
 * only charged on fast burns.
 */
export function feeLine(view: TransferView): { label: string; value: string } | null {
  const fee = view.feeExecuted ? BigInt(view.feeExecuted) : 0n;
  if (fee <= 0n) return null;
  const amount = `${formatUsdc(fee, 6)} USDC`;
  if (view.kind !== "forward") return { label: "Circle fee", value: amount };
  return view.minFinality >= FINALITY.standard
    ? { label: "Delivery", value: `${amount}, by Circle` }
    : { label: "Fees", value: `${amount}, Circle fee and delivery` };
}

const formatSol = (lamports: bigint) => formatAmount(lamports, 9, 4);
const formatWhen = (ms: number) => new Date(ms).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });

/** A Solana burn's deposit, ready to take back: only the wallet that paid it may. */
function RefundAction({
  env,
  view,
  lamports,
  rentPayer,
  solanaWallet,
  onConnectSolanaWallet,
  onDone,
}: {
  env: Env;
  view: TransferView;
  lamports: bigint;
  rentPayer: string;
  solanaWallet: SolanaWallet | null;
  onConnectSolanaWallet?: (() => void) | undefined;
  onDone: () => void;
}) {
  const [busy, setBusy] = useState(false);
  async function reclaim() {
    if (!solanaWallet) return;
    setBusy(true);
    try {
      await reclaimDeposit(env, solanaWallet, view);
      onDone();
    } catch (e) {
      showToast(friendlyError(e));
    } finally {
      setBusy(false);
    }
  }
  const mine = solanaWallet?.address === rentPayer;
  return (
    <div className="iub-claim">
      <p className="iub-muted">Sending from Solana left {formatSol(lamports)} SOL in a deposit account. It is yours to take back.</p>
      {mine ? (
        <button type="button" className="iub-secondary" disabled={busy} onClick={() => void reclaim()}>
          {busy ? <Spinner /> : null}
          {busy ? "Confirm in your wallet" : `Reclaim ${formatSol(lamports)} SOL`}
        </button>
      ) : solanaWallet ? (
        <Note>Connect {shortAddress(rentPayer)}, the Solana wallet that sent it, to reclaim it.</Note>
      ) : onConnectSolanaWallet ? (
        <button type="button" className="iub-secondary" onClick={onConnectSolanaWallet}>
          Connect a Solana wallet to reclaim it
        </button>
      ) : null}
    </div>
  );
}

/** Opt in to a browser notification for when a transfer lands, from a click as browsers require. */
function NotifyMe({ claim }: { claim: boolean }) {
  const [on, setOn] = useState(notificationsOn);
  if (!notificationsSupported() || (!on && Notification.permission === "denied")) return null;
  const when = claim ? "when it is ready to claim" : "when it lands";
  return on ? (
    <span className="iub-notify iub-muted">
      <IconBell /> You will get a notification {when}.
    </span>
  ) : (
    <button type="button" className="iub-notify iub-link" onClick={() => void enableNotifications().then(setOn)}>
      <IconBell /> Notify me {when}
    </button>
  );
}

function Note({ tone, children }: { tone?: "error"; children: ReactNode }) {
  return (
    <div className={tone ? `iub-note iub-note-${tone}` : "iub-note"} role={tone ? "alert" : undefined}>
      {tone ? <IconAlert /> : <IconInfo />}
      <span>{children}</span>
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

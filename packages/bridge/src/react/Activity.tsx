import { type CSSProperties, type ReactNode, useState } from "react";
import { chainByDomain } from "../chains.js";
import { USDC_DECIMALS } from "../constants.js";
import type { TransferView } from "./api.js";
import { ChainLogo, ChainPair } from "./ChainLogo.js";
import { formatAmount, timeAgo } from "./format.js";
import type { ActivityItem, Env } from "./hooks.js";
import { useNow, useSolanaEventAccounts } from "./hooks.js";
import { IconAlert, IconArrow, IconChevronRight, IconInbox, IconWallet, Spinner } from "./icons.js";
import { progressOf } from "./progress.js";
import { reclaimDeposit, refundState } from "./refunds.js";
import { StatusPill } from "./TransferStatus.js";
import type { SolanaWallet } from "./types.js";
import { friendlyError } from "./wallet.js";

export function Activity({
  env,
  connected,
  items,
  loading,
  error,
  onOpen,
  onStart,
  onConnectWallet,
  solanaWallet,
}: {
  env: Env;
  connected: boolean;
  items: ActivityItem[];
  loading: boolean;
  error: string | null;
  onOpen: (domain: number, txHash: string) => void;
  onStart: () => void;
  onConnectWallet?: (() => void) | undefined;
  solanaWallet?: SolanaWallet | null | undefined;
}) {
  const now = useNow(15_000);
  // Deposits from this Solana wallet's burns that it can take back now.
  const withRefund = solanaWallet ? items.flatMap((it) => (it.view?.solanaRefund ? [it.view] : [])) : [];
  const events = useSolanaEventAccounts(env, withRefund.map((v) => v.solanaRefund!.eventAccount));
  const refundable = withRefund.flatMap((view) => {
    const s = refundState(view, events.data, now);
    return s?.state === "ready" && s.rentPayer === solanaWallet?.address ? [{ view, lamports: s.lamports }] : [];
  });

  if (!connected) {
    return (
      <Empty icon={<IconWallet />} title="No wallet connected" text="Connect a wallet to see its transfers.">
        {onConnectWallet ? (
          <button type="button" className="iub-secondary" onClick={onConnectWallet}>
            Connect wallet
          </button>
        ) : null}
      </Empty>
    );
  }
  if (loading) {
    return (
      <div className="iub-body" aria-busy="true" aria-label="Loading transfers">
        <ul className="iub-activity">
          {[0, 1, 2].map((i) => (
            <li key={i} className="iub-activity-skeleton">
              <span className="iub-skeleton" style={{ width: 45, height: 28, borderRadius: 14 }} />
              <span className="iub-activity-main">
                <span className="iub-skeleton" style={{ width: 110, height: 14 }} />
                <span className="iub-skeleton" style={{ width: 160, height: 11 }} />
              </span>
            </li>
          ))}
        </ul>
      </div>
    );
  }
  if (items.length === 0) {
    return error ? (
      <Empty icon={<IconInbox />} title="Could not load transfers" text="The bridge service did not answer. This retries on its own." />
    ) : (
      <Empty icon={<IconInbox />} title="No transfers yet" text="Transfers you send from this wallet show up here, tracked until they land.">
        <button type="button" className="iub-secondary" onClick={onStart}>
          Start a transfer
        </button>
      </Empty>
    );
  }
  return (
    <div className="iub-body">
      {solanaWallet && refundable.length > 0 ? <RefundBanner env={env} wallet={solanaWallet} refundable={refundable} onDone={events.refresh} /> : null}
      <ul className="iub-activity">
        {items.map((it, i) => {
          const style = { "--i": Math.min(i, 10) } as CSSProperties;
          if (it.view) {
            const v = it.view;
            const p = progressOf(v, now);
            return (
              <li key={it.key} style={style}>
                <button type="button" onClick={() => onOpen(v.source.domain, v.source.txHash)}>
                  <ChainPair from={v.source} to={v.destination} size={28} />
                  <span className="iub-activity-main">
                    <strong>{formatAmount(BigInt(v.amount), USDC_DECIMALS, 2)} USDC</strong>
                    <span className="iub-activity-sub">
                      {v.source.name} <IconArrow /> {v.destination.name}
                      <span className="iub-dot-sep" aria-hidden />
                      {timeAgo(v.source.time, now)}
                    </span>
                  </span>
                  <StatusPill tone={p.tone} headline={p.headline} />
                  <span className="iub-activity-go" aria-hidden>
                    <IconChevronRight />
                  </span>
                </button>
              </li>
            );
          }
          const e = it.pending!;
          const src = chainByDomain(env.network, e.domain);
          return (
            <li key={it.key} style={style}>
              <button type="button" onClick={() => onOpen(e.domain, e.txHash)}>
                <span className="iub-pair" style={{ width: 45, height: 28 }}>
                  <ChainLogo chain={src?.key ?? null} name={src?.name ?? "?"} size={28} />
                </span>
                <span className="iub-activity-main">
                  <strong>Sent from {src?.name ?? `domain ${e.domain}`}</strong>
                  <span className="iub-activity-sub">{timeAgo(new Date(e.at).toISOString(), now)}</span>
                </span>
                <StatusPill tone="progress" headline="Confirming" />
                <span className="iub-activity-go" aria-hidden>
                  <IconChevronRight />
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/** One button for every deposit the wallet can take back; each is its own Solana transaction. */
function RefundBanner({
  env,
  wallet,
  refundable,
  onDone,
}: {
  env: Env;
  wallet: SolanaWallet;
  refundable: { view: TransferView; lamports: bigint }[];
  onDone: () => void;
}) {
  const [busy, setBusy] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const total = refundable.reduce((sum, r) => sum + r.lamports, 0n);
  const n = refundable.length;

  async function run() {
    setError(null);
    const queue = [...refundable];
    for (let i = 0; i < queue.length; i++) {
      setBusy(i);
      try {
        await reclaimDeposit(env, wallet, queue[i]!.view);
      } catch (e) {
        setError(friendlyError(e));
        break;
      }
    }
    setBusy(null);
    onDone();
  }

  return (
    <div className="iub-refund">
      <ChainLogo chain="solana" name="Solana" size={32} />
      <span className="iub-refund-text">
        <strong>{formatAmount(total, 9, 4)} SOL to reclaim</strong>
        <span className="iub-muted">{n === 1 ? "Left by your transfer from Solana" : `Left by ${n} transfers from Solana`}</span>
      </span>
      <button type="button" className="iub-secondary iub-refund-button" disabled={busy !== null} onClick={() => void run()}>
        {busy !== null ? <Spinner /> : null}
        {busy === null ? "Reclaim" : n > 1 ? `${busy + 1} of ${n}` : "Confirm"}
      </button>
      {error ? (
        <div className="iub-note iub-note-error iub-refund-error" role="alert">
          <IconAlert />
          <span>{error}</span>
        </div>
      ) : null}
    </div>
  );
}

function Empty({ icon, title, text, children }: { icon: ReactNode; title: string; text: string; children?: ReactNode }) {
  return (
    <div className="iub-body iub-empty">
      <span className="iub-empty-icon">{icon}</span>
      <strong>{title}</strong>
      <span className="iub-muted">{text}</span>
      {children}
    </div>
  );
}

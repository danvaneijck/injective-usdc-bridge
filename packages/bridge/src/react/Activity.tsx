import type { CSSProperties, ReactNode } from "react";
import { chainByDomain } from "../chains.js";
import { USDC_DECIMALS } from "../constants.js";
import { ChainLogo, ChainPair } from "./ChainLogo.js";
import { formatAmount, timeAgo } from "./format.js";
import type { ActivityItem, Env } from "./hooks.js";
import { useNow } from "./hooks.js";
import { IconArrow, IconChevronRight, IconInbox, IconWallet } from "./icons.js";
import { progressOf } from "./progress.js";
import { StatusPill } from "./TransferStatus.js";

export function Activity({
  env,
  connected,
  items,
  loading,
  error,
  onOpen,
  onStart,
  onConnectWallet,
}: {
  env: Env;
  connected: boolean;
  items: ActivityItem[];
  loading: boolean;
  error: string | null;
  onOpen: (domain: number, txHash: string) => void;
  onStart: () => void;
  onConnectWallet?: (() => void) | undefined;
}) {
  const now = useNow(15_000);
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

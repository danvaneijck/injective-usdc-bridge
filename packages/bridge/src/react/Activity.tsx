import { chainByDomain } from "../chains.js";
import { USDC_DECIMALS } from "../constants.js";
import { ChainLogo } from "./ChainLogo.js";
import { formatAmount, timeAgo } from "./format.js";
import type { ActivityItem, Env } from "./hooks.js";
import { useNow } from "./hooks.js";
import { progressOf } from "./progress.js";

export function Activity({
  env,
  connected,
  items,
  error,
  onOpen,
}: {
  env: Env;
  connected: boolean;
  items: ActivityItem[];
  error: string | null;
  onOpen: (domain: number, txHash: string) => void;
}) {
  const now = useNow(15_000);
  if (!connected) return <div className="iub-body iub-empty">Connect a wallet to see its transfers.</div>;
  if (items.length === 0) {
    return <div className="iub-body iub-empty">{error ? "Could not load transfers right now." : "No transfers yet."}</div>;
  }
  return (
    <div className="iub-body">
      <ul className="iub-activity">
        {items.map((it) => {
          if (it.view) {
            const v = it.view;
            const p = progressOf(v, now);
            return (
              <li key={it.key}>
                <button type="button" onClick={() => onOpen(v.source.domain, v.source.txHash)}>
                  <span className="iub-route">
                    <ChainLogo chain={v.source.chain} name={v.source.name} size={20} />
                    <span className="iub-route-arrow">to</span>
                    <ChainLogo chain={v.destination.chain} name={v.destination.name} size={20} />
                  </span>
                  <span className="iub-activity-main">
                    <strong>{formatAmount(BigInt(v.amount), USDC_DECIMALS, 2)} USDC</strong>
                    <span className="iub-muted">{timeAgo(v.source.time, now)}</span>
                  </span>
                  <span className={`iub-pill iub-pill-${p.tone}`}>{p.headline}</span>
                </button>
              </li>
            );
          }
          const e = it.pending!;
          const src = chainByDomain(env.network, e.domain);
          return (
            <li key={it.key}>
              <button type="button" onClick={() => onOpen(e.domain, e.txHash)}>
                <span className="iub-route">
                  <ChainLogo chain={src?.key ?? null} name={src?.name ?? "?"} size={20} />
                </span>
                <span className="iub-activity-main">
                  <strong>Sent from {src?.name ?? `domain ${e.domain}`}</strong>
                  <span className="iub-muted">{timeAgo(new Date(e.at).toISOString(), now)}</span>
                </span>
                <span className="iub-pill iub-pill-progress">Confirming</span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

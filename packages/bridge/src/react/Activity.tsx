import { type CSSProperties, type ReactNode, useState } from "react";
import { chainByDomain } from "../chains.js";
import { USDC_DECIMALS } from "../constants.js";
import type { TransferView } from "./api.js";
import { ChainLogo, ChainPair } from "./ChainLogo.js";
import { formatAmount, shortAddress, timeAgo } from "./format.js";
import type { ActivityItem, Env } from "./hooks.js";
import { useNow, usePoll, useSolanaEventAccounts } from "./hooks.js";
import { IconAlert, IconArrow, IconChevronRight, IconInbox, IconSearch, IconWallet, Spinner } from "./icons.js";
import { parseLookup } from "./lookup.js";
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
  lookup,
  onLookup,
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
  /** An address looked up by hand, shown instead of the wallets' transfers. */
  lookup: string | null;
  onLookup: (address: string | null) => void;
}) {
  const now = useNow(15_000);
  // Deposits from this Solana wallet's burns that it can take back now.
  const withRefund = solanaWallet ? items.flatMap((it) => (it.view?.solanaRefund ? [it.view] : [])) : [];
  const events = useSolanaEventAccounts(env, withRefund.map((v) => v.solanaRefund!.eventAccount));
  const refundable = withRefund.flatMap((view) => {
    const s = refundState(view, events.data, now);
    return s?.state === "ready" && s.rentPayer === solanaWallet?.address ? [{ view, lamports: s.lamports }] : [];
  });

  const finder = <Finder env={env} onOpen={onOpen} onAddress={onLookup} />;

  if (lookup) {
    return <LookedUp env={env} address={lookup} now={now} finder={finder} onOpen={onOpen} onClear={() => onLookup(null)} />;
  }
  if (!connected) {
    return (
      <div className="iub-body">
        {finder}
        <Empty icon={<IconWallet />} title="No wallet connected" text="Connect a wallet to see its transfers, or paste a transaction hash or address above.">
          {onConnectWallet ? (
            <button type="button" className="iub-secondary" onClick={onConnectWallet}>
              Connect wallet
            </button>
          ) : null}
        </Empty>
      </div>
    );
  }
  if (loading) {
    return (
      <div className="iub-body" aria-busy="true" aria-label="Loading transfers">
        {finder}
        <Skeleton />
      </div>
    );
  }
  if (items.length === 0) {
    return (
      <div className="iub-body">
        {finder}
        {error ? (
          <Empty icon={<IconInbox />} title="Could not load transfers" text="The bridge service did not answer. This retries on its own." />
        ) : (
          <Empty icon={<IconInbox />} title="No transfers yet" text="Transfers you send from this wallet show up here, tracked until they land.">
            <button type="button" className="iub-secondary" onClick={onStart}>
              Start a transfer
            </button>
          </Empty>
        )}
      </div>
    );
  }
  return (
    <div className="iub-body">
      {finder}
      {solanaWallet && refundable.length > 0 ? <RefundBanner env={env} wallet={solanaWallet} refundable={refundable} onDone={events.refresh} /> : null}
      <ul className="iub-activity">
        {items.map((it, i) => {
          if (it.view) return <ViewRow key={it.key} view={it.view} index={i} now={now} onOpen={onOpen} />;
          const e = it.pending!;
          const src = chainByDomain(env.network, e.domain);
          return (
            <li key={it.key} style={{ "--i": Math.min(i, 10) } as CSSProperties}>
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

function ViewRow({ view: v, index, now, onOpen }: { view: TransferView; index: number; now: number; onOpen: (domain: number, txHash: string) => void }) {
  const p = progressOf(v, now);
  return (
    <li style={{ "--i": Math.min(index, 10) } as CSSProperties}>
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

/**
 * Find a transfer without a wallet: a transaction hash opens it (whichever
 * chain sent it), an address lists its transfers.
 */
function Finder({ env, onOpen, onAddress }: { env: Env; onOpen: (domain: number, txHash: string) => void; onAddress: (address: string) => void }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function find() {
    const q = parseLookup(text);
    if (!q) {
      setError(text.trim() ? "That is not a transaction hash or an address." : null);
      return;
    }
    setError(null);
    if (q.kind === "address") {
      setText("");
      onAddress(q.address);
      return;
    }
    setBusy(true);
    try {
      const first = (await env.api.transfersByTx(q.tx))[0];
      if (first) {
        setText("");
        onOpen(first.source.domain, first.source.txHash);
      } else {
        setError("No transfer to or from Injective in that transaction. If it was sent moments ago, try again in a minute.");
      }
    } catch {
      setError("The bridge service did not answer. Try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      className="iub-finder"
      role="search"
      onSubmit={(e) => {
        e.preventDefault();
        void find();
      }}
    >
      <label className="iub-search">
        <IconSearch />
        <input
          placeholder="Find a transfer by hash or address"
          aria-label="Transaction hash or address"
          enterKeyHint="search"
          value={text}
          spellCheck={false}
          autoComplete="off"
          onChange={(e) => {
            setText(e.target.value);
            setError(null);
          }}
        />
        {busy ? (
          <Spinner />
        ) : text.trim() ? (
          <button type="submit" className="iub-link">
            Find
          </button>
        ) : null}
      </label>
      {error ? (
        <div className="iub-note iub-note-error" role="alert">
          <IconAlert />
          <span>{error}</span>
        </div>
      ) : null}
    </form>
  );
}

function LookedUp({
  env,
  address,
  now,
  finder,
  onOpen,
  onClear,
}: {
  env: Env;
  address: string;
  now: number;
  finder: ReactNode;
  onOpen: (domain: number, txHash: string) => void;
  onClear: () => void;
}) {
  const { data, error } = usePoll(`lookup:${address}`, () => env.api.transfers(address), 15_000);
  return (
    <div className="iub-body">
      {finder}
      <div className="iub-lookup-head">
        <span className="iub-muted">Transfers for</span>
        <span className="iub-mono" title={address}>
          {shortAddress(address)}
        </span>
        <button type="button" className="iub-link" onClick={onClear}>
          Clear
        </button>
      </div>
      {data === null && !error ? (
        <Skeleton />
      ) : data && data.length > 0 ? (
        <ul className="iub-activity">
          {data.map((v, i) => (
            <ViewRow key={v.id} view={v} index={i} now={now} onOpen={onOpen} />
          ))}
        </ul>
      ) : error ? (
        <Empty icon={<IconInbox />} title="Could not load transfers" text="The bridge service did not answer. This retries on its own." />
      ) : (
        <Empty icon={<IconInbox />} title="No transfers found" text="Nothing to or from Injective over CCTP for this address since the bridge started watching." />
      )}
    </div>
  );
}

function Skeleton() {
  return (
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
    <div className="iub-empty">
      <span className="iub-empty-icon">{icon}</span>
      <strong>{title}</strong>
      <span className="iub-muted">{text}</span>
      {children}
    </div>
  );
}

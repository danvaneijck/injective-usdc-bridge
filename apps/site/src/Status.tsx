import { type CSSProperties, type ReactNode, useEffect, useState } from "react";
import { type Network, chainByKey } from "injective-usdc-bridge";
import { ChainLogo } from "injective-usdc-bridge/react";

/** /v1/health, as service/src/health.ts writes it. */
interface Lane {
  chain: string;
  domain: number;
  indexedBlock: number | null;
  head: number | null;
  indexerUpdatedAt: string | null;
  waiting: number;
  oldestWaitingSec: number | null;
  expectedSec: number | null;
  lastAttestedAt: string | null;
  status: "ok" | "delayed" | "indexer_stalled" | "starting";
}

interface Health {
  ok: boolean;
  network: Network;
  mode: "shadow" | "relay";
  relayer: { address: string; balanceInj: number | null; low: boolean | null } | null;
  keeper: { floatInj: string | null; accruedFeesUsdc: string | null; lastRefillAt: string | null; lastIssue: string | null } | null;
  lanes: Lane[];
  counts: Record<string, number>;
}

const REFRESH_MS = 15_000;

function useHealth(apiUrl: string): { health: Health | null; error: boolean; at: number | null } {
  const [state, setState] = useState<{ health: Health | null; error: boolean; at: number | null }>({ health: null, error: false, at: null });
  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        // 503 means a lane needs attention; the body is the same report.
        const res = await fetch(`${apiUrl}/v1/health`, { cache: "no-store" });
        const body = (await res.json()) as Health;
        if (!Array.isArray(body.lanes)) throw new Error("not a health report");
        if (alive) setState({ health: body, error: false, at: Date.now() });
      } catch {
        if (alive) setState((s) => ({ ...s, error: true }));
      }
    };
    void load();
    const t = setInterval(load, REFRESH_MS);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [apiUrl]);
  return state;
}

function useNow(ms = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

function ago(iso: string | null, now: number): string | null {
  return iso ? agoMs(now - Date.parse(iso)) : null;
}

/** Indexers stay a few blocks back on purpose (reorgs); only more is news. */
const BEHIND_WORTH_SHOWING = 64;

function agoMs(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 5) return "just now";
  if (s < 60) return `${s} s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h} h ago`;
  return `${Math.floor(h / 24)} d ago`;
}

function duration(sec: number): string {
  if (sec < 60) return `${sec} s`;
  const m = Math.round(sec / 60);
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`;
}

const LANE_LABEL: Record<Lane["status"], string> = {
  ok: "Normal",
  delayed: "Circle slow",
  indexer_stalled: "Catching up",
  starting: "Starting",
};

type Tone = "ok" | "warn" | "down";

function summary(h: Health | null, error: boolean, nameOf: (key: string) => string): { tone: Tone; title: string; text: string } {
  if (!h) {
    return error
      ? { tone: "down", title: "Cannot reach the bridge service", text: "Transfers already sent are safe on chain and complete once it is back." }
      : { tone: "ok", title: "Checking", text: "Asking the bridge service how every chain is doing." };
  }
  const delayed = h.lanes.filter((l) => l.status === "delayed").map((l) => nameOf(l.chain));
  const stalled = h.lanes.filter((l) => l.status === "indexer_stalled").map((l) => nameOf(l.chain));
  if (delayed.length) {
    return {
      tone: "warn",
      title: `Circle is slow on ${list(delayed)}`,
      text: "Transfers from there are safe and will complete; Circle is taking longer than usual to approve them.",
    };
  }
  if (stalled.length) {
    return { tone: "warn", title: `Catching up on ${list(stalled)}`, text: "New transfers from there show up a little late. Nothing is lost." };
  }
  if (h.relayer?.low) {
    return { tone: "warn", title: "Delivery wallet is low on gas", text: "Deposits still arrive; you may be asked to finish one yourself." };
  }
  if (error) return { tone: "warn", title: "Last check failed", text: "Showing the previous answer while it retries." };
  return {
    tone: "ok",
    title: "All systems normal",
    text: h.mode === "relay" ? "Every chain is being watched and deposits are delivered automatically." : "Every chain is being watched.",
  };
}

function list(names: string[]): string {
  return names.length <= 2 ? names.join(" and ") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

export function StatusPage({ apiUrl }: { apiUrl: string }) {
  const { health, error, at } = useHealth(apiUrl);
  const now = useNow();
  const network: Network = health?.network ?? "mainnet";
  const nameOf = (key: string) => chainByKey(network, key)?.name ?? key;
  const s = summary(health, error, nameOf);
  // In flight is a burn Circle has yet to approve (the per-chain column) plus
  // one it has approved that is not minted yet. Expired and not-found
  // transfers are not moving, so they are not counted.
  const attesting = health?.counts.attesting ?? 0;
  const ready = health?.counts.ready ?? 0;
  const inFlight = health ? attesting + ready : null;
  const inFlightSub =
    inFlight === null || inFlight === 0
      ? "nothing waiting right now"
      : [attesting ? `${attesting} with Circle` : null, ready ? `${ready} approved, awaiting mint` : null].filter(Boolean).join(", ");

  return (
    <div className="status">
      <section className={`status-hero status-${s.tone}`}>
        <span className="status-orb" aria-hidden>
          <span />
        </span>
        <div>
          <h2>{s.title}</h2>
          <p>{s.text}</p>
        </div>
        <span className="status-updated">{at ? `Updated ${agoMs(now - at)}` : "Loading"}</span>
      </section>

      <section className="status-stats">
        <Stat label="Delivered" value={health ? (health.counts.delivered ?? 0).toLocaleString() : null} sub="transfers tracked to the end" />
        <Stat label="In flight" value={inFlight === null ? null : inFlight.toLocaleString()} sub={inFlightSub} />
        <Stat
          label="Auto-delivery"
          value={health ? (health.mode === "relay" ? "On" : "Watching only") : null}
          sub={
            health?.relayer?.balanceInj != null ? (
              <>
                <a href={`https://blockscout.injective.network/address/${health.relayer.address}`} target="_blank" rel="noreferrer">
                  Delivery wallet
                </a>{" "}
                has {health.relayer.balanceInj.toFixed(3)} INJ
              </>
            ) : (
              "deposits minted for you"
            )
          }
          tone={health?.relayer?.low ? "warn" : undefined}
        />
        <Stat
          label="Gas drop"
          value={health?.keeper?.floatInj != null ? `${Number(health.keeper.floatInj).toFixed(3)} INJ` : health ? "Off" : null}
          sub={health?.keeper ? (health.keeper.lastIssue ? "automatic refill needs a look" : "ready to hand out, refilled automatically") : "INJ for gas on arrival"}
          tone={health?.keeper?.lastIssue ? "warn" : undefined}
        />
      </section>

      <section className="status-lanes">
        <div className="status-lanes-head">
          <h3>Chains</h3>
          <span>{health ? `${health.lanes.length} watched` : ""}</span>
        </div>
        <div className="status-table" role="table" aria-label="Chains">
          <div className="status-row status-row-head" role="row">
            <span role="columnheader">Chain</span>
            <span role="columnheader">Status</span>
            <span role="columnheader">Synced</span>
            <span role="columnheader">With Circle</span>
            <span role="columnheader">Last approval</span>
          </div>
          {health
            ? health.lanes.map((l, i) => {
                const behind = l.head !== null && l.indexedBlock !== null ? Math.max(0, l.head - l.indexedBlock) : null;
                return (
                  <div className="status-row" role="row" key={l.chain} style={{ "--i": i } as CSSProperties}>
                    <span role="cell" className="status-chain">
                      <ChainLogo chain={l.chain} name={nameOf(l.chain)} size={28} />
                      <strong>{nameOf(l.chain)}</strong>
                    </span>
                    <span role="cell">
                      <span className={`status-chip status-chip-${l.status}`}>
                        <span className="status-dot" aria-hidden />
                        {LANE_LABEL[l.status]}
                      </span>
                    </span>
                    <span role="cell" data-label="Synced">
                      {ago(l.indexerUpdatedAt, now) ?? <span className="status-muted">Not yet</span>}
                      {behind !== null && behind > BEHIND_WORTH_SHOWING ? <span className="status-sub">{behind.toLocaleString()} blocks behind</span> : null}
                    </span>
                    <span role="cell" data-label="With Circle">
                      {l.waiting === 0 ? (
                        <span className="status-muted">None</span>
                      ) : (
                        <>
                          {l.waiting}
                          {l.oldestWaitingSec !== null ? (
                            <span className="status-sub">
                              oldest {duration(l.oldestWaitingSec)}
                              {l.expectedSec ? ` of ~${duration(l.expectedSec)}` : ""}
                            </span>
                          ) : null}
                        </>
                      )}
                    </span>
                    <span role="cell" data-label="Last approval">
                      {ago(l.lastAttestedAt, now) ?? <span className="status-muted">None yet</span>}
                    </span>
                  </div>
                );
              })
            : Array.from({ length: 6 }, (_, i) => (
                <div className="status-row" role="row" key={i}>
                  <span className="status-skeleton" style={{ width: 140 }} />
                  <span className="status-skeleton" style={{ width: 80 }} />
                  <span className="status-skeleton" style={{ width: 70 }} />
                  <span className="status-skeleton" style={{ width: 40 }} />
                  <span className="status-skeleton" style={{ width: 70 }} />
                </div>
              ))}
        </div>
      </section>

      <p className="status-foot">
        Refreshes every {REFRESH_MS / 1000} s. Raw report:{" "}
        <a href={`${apiUrl}/v1/health`} target="_blank" rel="noreferrer">
          /v1/health
        </a>
      </p>
    </div>
  );
}

function Stat({ label, value, sub, tone }: { label: string; value: string | null; sub: ReactNode; tone?: "warn" | undefined }) {
  return (
    <div className={tone ? `status-stat status-stat-${tone}` : "status-stat"}>
      <span className="status-stat-label">{label}</span>
      {value === null ? <span className="status-skeleton" style={{ width: 70, height: 26 }} /> : <strong>{value}</strong>}
      <span className="status-stat-sub">{sub}</span>
    </div>
  );
}

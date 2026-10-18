import { type CSSProperties, type KeyboardEvent, useEffect, useRef, useState } from "react";
import type { Chain } from "../chains.js";
import { FINALITY, type Network } from "../constants.js";
import type { Direction } from "../quote.js";
import { expectedAttestMs } from "../timing.js";
import { ChainLogo } from "./ChainLogo.js";
import { formatDuration, formatUsdc } from "./format.js";
import { IconBolt, IconCheck, IconSearch } from "./icons.js";
import { Sheet } from "./Sheet.js";

/** Tiles in the one-tap row above the list: two rows of five. */
const QUICK = 10;

/** Chains holding the wallet's USDC first, most first; the rest keep the registry's order. */
export function sortByBalance(chains: readonly Chain[], held: (c: Chain) => bigint): Chain[] {
  const order = new Map(chains.map((c, i) => [c.key, i]));
  return [...chains].sort((a, b) => {
    const x = held(a);
    const y = held(b);
    if (x !== y) return x > y ? -1 : 1;
    return order.get(a.key)! - order.get(b.key)!;
  });
}

export function ChainPicker({
  open,
  network,
  chains,
  direction,
  selected,
  balances,
  onPick,
  onClose,
}: {
  open: boolean;
  network: Network;
  chains: Chain[];
  direction: Direction;
  selected: string;
  /** The wallet's USDC per chain, shown and sorted first; null to leave them out. */
  balances: Map<string, bigint> | null;
  onPick: (key: string) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const list = useRef<HTMLUListElement>(null);
  useEffect(() => {
    if (open) setQuery("");
  }, [open]);

  const q = query.trim().toLowerCase();
  const matching = q
    ? chains.filter((c) => c.name.toLowerCase().includes(q) || c.key.includes(q) || c.nativeSymbol.toLowerCase() === q)
    : chains;
  const held = (c: Chain) => balances?.get(c.key) ?? 0n;
  const shown = balances ? sortByBalance(matching, held) : matching;

  function subline(c: Chain): string {
    if (direction === "withdraw") return c.forwarding ? "Delivered by Circle" : `You claim it there, needs ${c.nativeSymbol}`;
    const ms = expectedAttestMs(network, c.domain, c.fastSource ? FINALITY.fast : FINALITY.standard);
    return `About ${formatDuration(ms)}`;
  }

  /** Arrow keys walk the list; from the search box, Down enters it. */
  function onListKey(e: KeyboardEvent) {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    const rows = [...(list.current?.querySelectorAll<HTMLButtonElement>("button") ?? [])];
    if (rows.length === 0) return;
    e.preventDefault();
    const at = rows.indexOf(document.activeElement as HTMLButtonElement);
    const next = e.key === "ArrowDown" ? Math.min(rows.length - 1, at + 1) : at <= 0 ? -1 : at - 1;
    if (next === -1) (e.currentTarget.closest(".iub-sheet")?.querySelector("input") as HTMLInputElement | null)?.focus();
    else rows[next]!.focus();
  }

  return (
    <Sheet open={open} onClose={onClose} title={direction === "deposit" ? "Bridge from" : "Bridge to"}>
      <div onKeyDown={onListKey} className="iub-picker">
        <label className="iub-search">
          <IconSearch />
          <input
            data-autofocus
            placeholder="Search chains"
            aria-label="Search chains"
            value={query}
            spellCheck={false}
            autoComplete="off"
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && shown[0]) onPick(shown[0].key);
            }}
          />
        </label>
        {q ? null : (
          // The usual picks one tap away, the way wallet pickers do it; the
          // full list with times and balances stays below.
          <div className="iub-quick" role="group" aria-label="Popular chains">
            {shown.slice(0, QUICK).map((c) => (
              <button key={c.key} type="button" aria-current={c.key === selected} title={c.name} aria-label={c.name} onClick={() => onPick(c.key)}>
                <ChainLogo chain={c.key} name={c.name} size={30} />
              </button>
            ))}
          </div>
        )}
        {shown.length === 0 ? (
          <div className="iub-picker-empty">No chain matches "{query.trim()}"</div>
        ) : (
          <ul className="iub-chains" ref={list}>
            {shown.map((c, i) => (
              <li key={c.key} style={{ "--i": Math.min(i, 10) } as CSSProperties}>
                <button type="button" aria-current={c.key === selected} onClick={() => onPick(c.key)}>
                  <ChainLogo chain={c.key} name={c.name} size={34} />
                  <span className="iub-chains-text">
                    <span className="iub-chains-name">{c.name}</span>
                    <span className="iub-chains-sub">{subline(c)}</span>
                  </span>
                  <span className="iub-chains-end">
                    {held(c) > 0n ? <span className="iub-chains-balance">{formatUsdc(held(c))} USDC</span> : null}
                    {direction === "deposit" && c.fastSource ? (
                      <span className="iub-chip">
                        <IconBolt /> Fast
                      </span>
                    ) : null}
                  </span>
                  <span className="iub-chains-check" aria-hidden>
                    {c.key === selected ? <IconCheck /> : null}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Sheet>
  );
}

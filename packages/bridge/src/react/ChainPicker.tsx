import { type CSSProperties, type KeyboardEvent, useEffect, useRef, useState } from "react";
import type { EvmChain } from "../chains.js";
import { FINALITY, type Network } from "../constants.js";
import type { Direction } from "../quote.js";
import { expectedAttestMs } from "../timing.js";
import { ChainLogo } from "./ChainLogo.js";
import { formatDuration } from "./format.js";
import { IconBolt, IconCheck, IconSearch } from "./icons.js";
import { Sheet } from "./Sheet.js";

export function ChainPicker({
  open,
  network,
  chains,
  direction,
  selected,
  onPick,
  onClose,
}: {
  open: boolean;
  network: Network;
  chains: EvmChain[];
  direction: Direction;
  selected: string;
  onPick: (key: string) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const list = useRef<HTMLUListElement>(null);
  useEffect(() => {
    if (open) setQuery("");
  }, [open]);

  const q = query.trim().toLowerCase();
  const shown = q
    ? chains.filter((c) => c.name.toLowerCase().includes(q) || c.key.includes(q) || c.nativeSymbol.toLowerCase() === q)
    : chains;

  function subline(c: EvmChain): string {
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
                  {direction === "deposit" && c.fastSource ? (
                    <span className="iub-chip">
                      <IconBolt /> Fast
                    </span>
                  ) : null}
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

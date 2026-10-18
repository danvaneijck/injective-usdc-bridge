import { type ReactNode, useEffect, useRef, useState } from "react";
import { IconClose } from "./icons.js";

/** How long anything takes to animate out; matches the CSS. */
export const EXIT_MS = 200;

/** Keeps something mounted for a moment after it closes, so it can animate out. */
export function usePresence(open: boolean, ms = EXIT_MS): { mounted: boolean; closing: boolean } {
  const [mounted, setMounted] = useState(open);
  useEffect(() => {
    if (open) {
      setMounted(true);
      return;
    }
    const t = setTimeout(() => setMounted(false), ms);
    return () => clearTimeout(t);
  }, [open, ms]);
  return { mounted: mounted || open, closing: !open && mounted };
}

const FOCUSABLE = 'button:not([disabled]), input:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])';

/**
 * A panel that slides up over the widget (never over the host page, so an
 * embedding app's stacking and styles stay out of it). Escape and the
 * backdrop close it; focus stays inside while it is open and returns to
 * whatever opened it.
 */
export function Sheet({ open, onClose, title, children }: { open: boolean; onClose: () => void; title: string; children: ReactNode }) {
  const { mounted, closing } = usePresence(open);
  const panel = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  close.current = onClose;

  useEffect(() => {
    if (!open) return;
    const opener = document.activeElement as HTMLElement | null;
    const el = panel.current;
    // Typing straight into the search box suits a mouse; on a phone it would
    // throw the keyboard over the list.
    const fine = typeof window.matchMedia === "function" && window.matchMedia("(pointer: fine)").matches;
    const first = fine ? el?.querySelector<HTMLElement>("[data-autofocus]") : null;
    (first ?? el)?.focus({ preventScroll: true });
    // The widget can be taller than a phone's screen, so the sheet may open
    // partly below the fold. Its height is capped to the viewport in CSS;
    // bring all of it into view.
    const still = typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    el?.scrollIntoView?.({ block: "nearest", behavior: still ? "auto" : "smooth" });

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        close.current();
      } else if (e.key === "Tab" && el) {
        const items = [...el.querySelectorAll<HTMLElement>(FOCUSABLE)];
        if (items.length === 0) return;
        const head = items[0]!;
        const tail = items[items.length - 1]!;
        if (e.shiftKey && (document.activeElement === head || document.activeElement === el)) {
          e.preventDefault();
          tail.focus();
        } else if (!e.shiftKey && document.activeElement === tail) {
          e.preventDefault();
          head.focus();
        }
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      opener?.focus?.();
    };
  }, [open]);

  if (!mounted) return null;
  return (
    <div className={closing ? "iub-sheet-layer iub-closing" : "iub-sheet-layer"}>
      <div className="iub-sheet-backdrop" onClick={onClose} />
      <div className="iub-sheet" role="dialog" aria-modal="true" aria-label={title} ref={panel} tabIndex={-1}>
        <div className="iub-sheet-head">
          <strong>{title}</strong>
          <button type="button" className="iub-icon-btn" aria-label="Close" onClick={onClose}>
            <IconClose />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

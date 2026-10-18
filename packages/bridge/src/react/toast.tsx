import { useEffect, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { IconAlert, IconClose, IconInfo } from "./icons.js";

/**
 * Passing messages about something that just happened (a send cancelled in
 * the wallet, a claim that failed, a search that found nothing). They sit in
 * the corner of the screen and leave on their own, rather than staying in the
 * form as if they still described it. What describes the form as it is (a bad
 * address, not enough USDC) stays inline.
 */
export interface Toast {
  id: number;
  text: string;
  tone: "error" | "info";
  leaving: boolean;
}

const SHOW_MS = 6_000;
const LEAVE_MS = 200;
const MAX = 3;

let toasts: Toast[] = [];
let nextId = 1;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

export function showToast(text: string, tone: Toast["tone"] = "error"): void {
  const id = nextId++;
  // The same message again restarts it rather than stacking a copy.
  toasts = [...toasts.filter((t) => t.text !== text), { id, text, tone, leaving: false }].slice(-MAX);
  emit();
  setTimeout(() => dismissToast(id), SHOW_MS);
}

export function dismissToast(id: number): void {
  if (!toasts.some((t) => t.id === id && !t.leaving)) return;
  toasts = toasts.map((t) => (t.id === id ? { ...t, leaving: true } : t));
  emit();
  setTimeout(() => {
    toasts = toasts.filter((t) => t.id !== id);
    emit();
  }, LEAVE_MS);
}

function useToasts(): Toast[] {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => toasts,
    () => toasts,
  );
}

/** One host per page, however many widgets are mounted, or every toast would show twice. */
let host: symbol | null = null;

/**
 * Renders the toasts at the bottom right of the page (bottom of the screen on
 * a phone). Mounted by Bridge and TransferStatus; a host page that wants its
 * own messages there too can call showToast.
 */
export function Toasts() {
  const [me] = useState(() => Symbol("toasts"));
  const [active, setActive] = useState(false);
  const list = useToasts();
  useEffect(() => {
    if (host === null) {
      host = me;
      setActive(true);
    }
    return () => {
      if (host === me) host = null;
    };
  }, [me]);
  if (!active || typeof document === "undefined") return null;
  return createPortal(
    <div className="iub-toasts" role="region" aria-label="Notifications" aria-live="polite">
      {list.map((t) => (
        <div key={t.id} className={`iub-toast iub-toast-${t.tone}${t.leaving ? " iub-toast-leaving" : ""}`} role={t.tone === "error" ? "alert" : "status"}>
          {t.tone === "error" ? <IconAlert /> : <IconInfo />}
          <span>{t.text}</span>
          <button type="button" aria-label="Dismiss" onClick={() => dismissToast(t.id)}>
            <IconClose />
          </button>
        </div>
      ))}
    </div>,
    document.body,
  );
}

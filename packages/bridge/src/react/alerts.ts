import { useEffect, useRef, useState } from "react";
import { USDC_DECIMALS } from "../constants.js";
import type { TransferView } from "./api.js";
import { formatAmount, formatDuration } from "./format.js";
import { useNow } from "./hooks.js";
import { progressOf } from "./progress.js";

const OPT_IN_KEY = "iub:notify";
/** Transfers already announced, across every watcher on the page. */
const announced = new Set<string>();
/** Opted in on this page, for when storage is blocked. */
let optedInHere = false;

export function notificationsSupported(): boolean {
  return typeof window !== "undefined" && "Notification" in window;
}

/** The user asked for notifications here and the browser allows them. */
export function notificationsOn(): boolean {
  if (!notificationsSupported() || Notification.permission !== "granted") return false;
  try {
    return localStorage.getItem(OPT_IN_KEY) === "1";
  } catch {
    return false;
  }
}

/** From a click: asks the browser if it has not been asked. Resolves to whether notifications will show. */
export async function enableNotifications(): Promise<boolean> {
  if (!notificationsSupported()) return false;
  const permission = Notification.permission === "default" ? await Notification.requestPermission() : Notification.permission;
  if (permission !== "granted") return false;
  try {
    localStorage.setItem(OPT_IN_KEY, "1");
  } catch {
    // Storage blocked: optedInHere keeps them on for this page's life.
  }
  optedInHere = true;
  return true;
}

const allowed = () => notificationsOn() || (optedInHere && Notification.permission === "granted");

type Stage = "moving" | "landed" | "claim";

/** Where a transfer stands for an alert: on its way, landed, or waiting for its owner to claim it. */
export function stageOf(v: TransferView): Stage {
  if (v.phase === "delivered") return "landed";
  if (v.phase === "ready" && v.direction === "withdraw" && v.kind !== "forward") return "claim";
  return "moving";
}

export function landingMessage(v: TransferView, stage: Exclude<Stage, "moving">): { title: string; body: string } {
  const amount = `${formatAmount(BigInt(v.amount), USDC_DECIMALS, 2)} USDC`;
  return stage === "landed"
    ? { title: `${amount} arrived on ${v.destination.name}`, body: `Your transfer from ${v.source.name} was delivered.` }
    : { title: `${amount} is ready to claim on ${v.destination.name}`, body: "Circle approved it. Open the bridge and send one transaction to receive it." };
}

/**
 * A few words for the tab title while transfers are on their way, null when
 * none are. `pending` counts sends the service has not picked up yet.
 */
export function titleStatus(views: TransferView[], pending: number, now: number): string | null {
  const open = views.filter((v) => v.phase !== "delivered");
  const total = open.length + pending;
  if (total === 0) return null;
  if (total > 1) return `${total} transfers on the way`;
  const v = open[0];
  if (!v) return "Confirming";
  if (v.phase === "attesting" || v.phase === "not_found") {
    const sent = v.source.time ? Date.parse(v.source.time) : now;
    const left = v.expectedAttestSec * 1000 - (now - sent);
    if (left >= 60_000) return `${formatDuration(left)} left`;
  }
  return progressOf(v, now).headline;
}

/**
 * Watches transfers for the moment they land (or wait to be claimed): a
 * browser notification when the user opted in and the tab is in the
 * background, and with `title`, their progress in the tab title meanwhile.
 * Only a change seen here is announced, never one that happened before.
 */
export function useTransferAlerts(views: TransferView[], opts: { title: boolean; pending?: number }): void {
  const now = useNow(5_000);
  const seen = useRef(new Map<string, Stage>());
  /** Landed while the tab was in the background: said in the title until the user looks. */
  const [unseen, setUnseen] = useState<string | null>(null);

  useEffect(() => {
    for (const v of views) {
      const stage = stageOf(v);
      const before = seen.current.get(v.id);
      seen.current.set(v.id, stage);
      if (before !== "moving" || stage === "moving") continue;
      const hidden = typeof document !== "undefined" && document.visibilityState !== "visible";
      if (hidden) setUnseen(stage === "landed" ? "Delivered" : "Ready to claim");
      if (!hidden || announced.has(v.id) || !allowed()) continue;
      announced.add(v.id);
      const msg = landingMessage(v, stage);
      try {
        const n = new Notification(msg.title, { body: msg.body, tag: `iub:${v.id}` });
        n.onclick = () => {
          window.focus();
          n.close();
        };
      } catch {
        // Some mobile browsers only notify from a service worker.
      }
    }
  }, [views]);

  useEffect(() => {
    if (!unseen) return;
    const onVisible = () => document.visibilityState === "visible" && setTimeout(() => setUnseen(null), 4_000);
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [unseen]);

  useTitlePrefix(opts.title ? (titleStatus(views, opts.pending ?? 0, now) ?? unseen) : null);
}

/**
 * Puts `status` in front of the page's own title, and takes it off again. A
 * title the host sets meanwhile becomes the new base.
 */
function useTitlePrefix(status: string | null): void {
  const base = useRef<string | null>(null);
  const lastSet = useRef<string | null>(null);
  useEffect(() => {
    if (typeof document === "undefined") return;
    if (base.current === null || document.title !== lastSet.current) base.current = document.title;
    const next = status ? `${status} | ${base.current}` : base.current;
    if (document.title !== next) document.title = next;
    lastSet.current = next;
  });
  useEffect(
    () => () => {
      if (base.current !== null && document.title === lastSet.current) document.title = base.current;
    },
    [],
  );
}

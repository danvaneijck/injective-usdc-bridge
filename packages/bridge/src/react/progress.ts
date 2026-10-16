import type { TransferView } from "./api.js";
import { formatDuration } from "./format.js";

export type StepState = "done" | "active" | "waiting" | "problem";

export interface Step {
  label: string;
  detail: string | null;
  state: StepState;
  link: string | null;
}

export interface Progress {
  headline: string;
  tone: "progress" | "done" | "attention";
  steps: [Step, Step, Step];
  /** Offer the user a button to finish it themselves. */
  canClaim: boolean;
}

/** After this long ready and unminted, the user may finish it themselves. */
export const CLAIM_AFTER_MS = 3 * 60_000;

/**
 * What a transfer's status means for the person waiting on it. The three steps
 * are the three things that actually happen: the burn, Circle's approval, and
 * the mint on the other side.
 */
export function progressOf(v: TransferView, now: number): Progress {
  const sent = v.source.time ? Date.parse(v.source.time) : now;
  const expected = v.expectedAttestSec * 1000;
  const forwarded = v.kind === "forward";
  const selfClaim = v.direction === "withdraw" && !forwarded;

  const burn: Step = { label: `Sent from ${v.source.name}`, detail: null, state: "done", link: v.source.txUrl };

  let approval: Step;
  switch (v.phase) {
    case "not_found":
    case "attesting": {
      const elapsed = now - sent;
      const late = elapsed > expected * 1.5;
      approval = {
        label: "Circle approval",
        detail: late
          ? `Taking longer than the usual ${formatDuration(expected)}`
          : `Usually about ${formatDuration(expected)}, ${formatDuration(Math.max(0, expected - elapsed))} to go`,
        state: "active",
        link: null,
      };
      break;
    }
    case "expired":
      approval = { label: "Circle approval", detail: "Expired before delivery, being renewed now", state: "problem", link: null };
      break;
    default:
      approval = { label: "Circle approval", detail: null, state: "done", link: null };
  }

  const readyFor = v.attestedAt ? now - Date.parse(v.attestedAt) : 0;
  let arrive: Step;
  if (v.phase === "delivered") {
    const took = v.deliveredAt ? Date.parse(v.deliveredAt) - sent : null;
    arrive = {
      label: `Arrived on ${v.destination.name}`,
      detail: took !== null && took > 0 ? `In ${formatDuration(took)}` : null,
      state: "done",
      link: v.destination.mintTxUrl,
    };
  } else if (v.phase === "ready") {
    arrive = {
      label: `Arriving on ${v.destination.name}`,
      detail: selfClaim
        ? `Ready for you to claim on ${v.destination.name}`
        : forwarded
          ? "Circle is delivering it"
          : "Being delivered",
      state: "active",
      link: null,
    };
  } else {
    arrive = { label: `Arrives on ${v.destination.name}`, detail: null, state: "waiting", link: null };
  }

  const canClaim = v.phase === "ready" && v.claim !== null && (selfClaim || readyFor > CLAIM_AFTER_MS);
  const headline =
    v.phase === "delivered"
      ? "Delivered"
      : v.phase === "ready"
        ? selfClaim
          ? "Ready to claim"
          : "Delivering"
        : v.phase === "expired"
          ? "Renewing approval"
          : "Waiting for Circle";
  const tone = v.phase === "delivered" ? "done" : v.phase === "expired" || canClaim ? "attention" : "progress";
  return { headline, tone, steps: [burn, approval, arrive], canClaim };
}

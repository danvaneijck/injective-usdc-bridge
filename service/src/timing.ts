// The widget shows the same estimate, so it lives in the core package.
export { expectedAttestMs } from "injective-usdc-bridge";

const SECOND = 1_000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;

export function notFoundDelay(ageMs: number): number {
  if (ageMs < 2 * MINUTE) return 3 * SECOND;
  if (ageMs < 15 * MINUTE) return 15 * SECOND;
  if (ageMs < 2 * HOUR) return MINUTE;
  return 5 * MINUTE;
}

export function attestingDelay(ageMs: number, expectedMs: number): number {
  if (ageMs < expectedMs) return Math.max(3 * SECOND, Math.min(30 * SECOND, expectedMs / 10));
  if (ageMs < 3 * expectedMs) return 30 * SECOND;
  return 2 * MINUTE;
}

/** Attested and not minted yet: watch closely at first, then back off. */
export function readyDelay(sinceAttestMs: number): number {
  if (sinceAttestMs < 5 * MINUTE) return 5 * SECOND;
  if (sinceAttestMs < HOUR) return 30 * SECOND;
  if (sinceAttestMs < 24 * HOUR) return 2 * MINUTE;
  return 15 * MINUTE;
}

export function relayRetryDelay(attempts: number): number {
  return [30 * SECOND, 2 * MINUTE, 10 * MINUTE, HOUR][Math.min(attempts - 1, 3)] ?? HOUR;
}

/** Spaces calls to one upstream (Iris blocks an IP for 5 min above 35 req/s). */
export class RateLimiter {
  private next = 0;
  constructor(private readonly perSecond: number) {}

  async take(): Promise<void> {
    const interval = 1000 / this.perSecond;
    const now = Date.now();
    const at = Math.max(now, this.next);
    this.next = at + interval;
    if (at > now) await new Promise((r) => setTimeout(r, at - now));
  }
}

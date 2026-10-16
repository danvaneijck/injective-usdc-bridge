import { type Chain, INJECTIVE_DOMAIN } from "./chains.js";
import { FINALITY, type Speed } from "./constants.js";
import type { IrisClient, IrisFeeTier } from "./iris.js";

export type Direction = "deposit" | "withdraw";

export interface Route {
  source: Chain;
  destination: Chain;
}

/**
 * Every fee in USDC base units (6 decimals).
 *
 * `bridgeFee` is ours and is always 0 today. It exists so a future fee can be
 * added without changing the shape callers render; it would be collected by a
 * contract on Injective (see DESIGN.md "Fees"), not by a separate transfer.
 */
export interface Quote {
  direction: Direction;
  amount: bigint;
  speed: Speed;
  minFinalityThreshold: number;
  /** Circle protocol fee ceiling for Fast Transfer; 0 for Standard. */
  protocolFee: bigint;
  /** Circle Forwarding Service fee; 0 when we do not forward. */
  forwardingFee: bigint;
  /** USDC paid for the INJ gas drop on deposits; 0 without one. */
  gasDropFee: bigint;
  bridgeFee: bigint;
  /** Passed to depositForBurn. Must cover protocolFee + forwardingFee. */
  maxFee: bigint;
  /** Lower bound on what lands, since Circle may charge up to maxFee. */
  minReceived: bigint;
  /** Circle submits the destination mint. */
  forwarded: boolean;
}

export type ForwardTier = "low" | "med" | "high";

export interface QuoteOptions {
  iris: IrisClient;
  route: Route;
  amount: bigint;
  /** Defaults to fast when the source supports it. */
  speed?: Speed;
  /** Defaults to true whenever Circle can forward to the destination. */
  forward?: boolean;
  forwardTier?: ForwardTier;
  /** Extra headroom on the protocol fee, in percent. Circle suggests ~20. */
  protocolFeeBufferPct?: number;
  /** Deposits only: the BridgeReceiver drop fee the user will pay. */
  gasDropFee?: bigint;
}

export class RouteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RouteError";
  }
}

export function routeDirection(route: Route): Direction {
  const srcIsInj = route.source.domain === INJECTIVE_DOMAIN;
  const dstIsInj = route.destination.domain === INJECTIVE_DOMAIN;
  if (srcIsInj === dstIsInj) {
    throw new RouteError(
      `Route ${route.source.key} -> ${route.destination.key} must have Injective on exactly one end`,
    );
  }
  return dstIsInj ? "deposit" : "withdraw";
}

/** ceil(amount * bps / 10_000) with fractional bps (e.g. 1.3). */
export function bpsFee(amount: bigint, bps: number): bigint {
  if (bps <= 0) return 0n;
  const hundredths = BigInt(Math.round(bps * 100));
  return (amount * hundredths + 999_999n) / 1_000_000n;
}

export async function quoteTransfer(opts: QuoteOptions): Promise<Quote> {
  const { route, amount, iris } = opts;
  const direction = routeDirection(route);
  if (amount <= 0n) throw new RouteError("Amount must be positive");

  const speed: Speed = opts.speed ?? (route.source.fastSource ? "fast" : "standard");
  const forwarded = opts.forward ?? route.destination.forwarding;
  if (forwarded && !route.destination.forwarding) {
    throw new RouteError(`Circle does not forward to ${route.destination.name}`);
  }

  const tiers = await iris.getFees(route.source.domain, route.destination.domain, {
    forward: forwarded,
  });
  const threshold = speed === "fast" && route.source.fastSource ? FINALITY.fast : FINALITY.standard;
  const tier = pickTier(tiers, threshold);

  const buffer = opts.protocolFeeBufferPct ?? 20;
  const rawProtocol = threshold === FINALITY.fast ? bpsFee(amount, tier.minimumFee) : 0n;
  const protocolFee = rawProtocol === 0n ? 0n : rawProtocol + (rawProtocol * BigInt(buffer) + 99n) / 100n;

  let forwardingFee = 0n;
  if (forwarded) {
    if (!tier.forwardFee) throw new RouteError("Iris returned no forwarding fee");
    forwardingFee = BigInt(tier.forwardFee[opts.forwardTier ?? "med"]);
  }

  const gasDropFee = opts.gasDropFee ?? 0n;
  if (gasDropFee > 0n && direction !== "deposit") {
    throw new RouteError("Gas drop is only available on deposits to Injective");
  }
  const bridgeFee = 0n;
  const maxFee = protocolFee + forwardingFee;
  // A burn that cannot cover its own fees is the class that left v1 transfers
  // locked forever. Refuse it here rather than on chain. (BridgeReceiver would
  // now deliver without the drop instead of reverting, but the user should
  // not be offered a drop they cannot afford.)
  const totalFees = maxFee + gasDropFee + bridgeFee;
  if (amount <= totalFees) {
    throw new RouteError(`Amount ${amount} does not cover fees ${totalFees} (USDC base units)`);
  }

  return {
    direction,
    amount,
    speed: threshold === FINALITY.fast ? "fast" : "standard",
    minFinalityThreshold: threshold,
    protocolFee,
    forwardingFee,
    gasDropFee,
    bridgeFee,
    maxFee,
    minReceived: amount - totalFees,
    forwarded,
  };
}

function pickTier(tiers: IrisFeeTier[], threshold: number): IrisFeeTier {
  const exact = tiers.find((t) => t.finalityThreshold === threshold);
  if (exact) return exact;
  const standard = tiers.find((t) => t.finalityThreshold === FINALITY.standard);
  if (standard) return standard;
  throw new RouteError(`Iris returned no fee tier for finality ${threshold}`);
}

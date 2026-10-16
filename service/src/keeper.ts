import {
  type Account,
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
  decodeFunctionData,
  encodeFunctionData,
  formatEther,
  formatUnits,
  getAddress,
  parseAbi,
  zeroAddress,
} from "viem";
import { type EvmChain, bridgeReceiverAbi, erc20Abi, feeOverrides } from "injective-usdc-bridge";
import type { Logger } from "./log.js";

/**
 * Refill keeper: keeps BridgeReceiver's INJ float and the relayer's own gas
 * topped up out of the gas-drop fees, so neither needs a manual top-up.
 *
 * One tick:
 *  1. Read the float (the receiver's INJ), the relayer's INJ and USDC, and
 *     the receiver's accrued fees. Nothing under its low mark: done.
 *  2. Price what is missing with the chain's own INJ/USD oracle.
 *  3. Sweep just enough fees to the relayer (the receiver lets the sweeper
 *     sweep only to itself).
 *  4. Swap that USDC to native INJ through Choice's aggregator, on a route
 *     from Choice's /route API that {@link checkRoute} vets before signing.
 *  5. Send the float its share; the relayer keeps the rest.
 *
 * The relayer is refilled first: it delivers everyone's deposits, while an
 * empty float only skips (and refunds) drops.
 */

/** Choice v2 on Injective mainnet (choice_v2_contracts deployments/injective_mainnet.json). */
export const CHOICE_MAINNET = {
  /** ChoiceAggregator 1.1.0: the contract /route builds calldata for, and its Permit2 spender. */
  aggregator: "0xa705d0D5f549Af25024038dc575E3074B9Bd37c9" as Address,
  permit2: "0x000000000022D473030F116dDEE9F6B43aC78BA3" as Address,
};

/**
 * The chain's oracle module as a precompile, read for INJ/USD from the feed
 * Choice v2's api ratified (PythPro 46). Independent of every pool and of the
 * route api, which is what makes it a floor rather than a second opinion.
 */
export const INJ_USD_ORACLE = {
  precompile: "0x0000000000000000000000000000000000000067" as Address,
  oracleType: 14,
  base: "46",
  quote: "USD",
};

export const aggregatorAbi = parseAbi([
  "struct Step { uint8 kind; address tokenIn; address tokenOut; uint16 shareBps; bytes data; }",
  "struct RouteParams { address currencyIn; address currencyOut; uint256 amountIn; uint256 minimumReceive; address recipient; uint256 deadline; uint16 feeBps; address feeRecipient; Step[] steps; }",
  "function execute(RouteParams p) payable returns (uint256 amountOut)",
]);

const permit2Abi = parseAbi([
  "function allowance(address user, address token, address spender) view returns (uint160 amount, uint48 expiration, uint48 nonce)",
  "function approve(address token, address spender, uint160 amount, uint48 expiration)",
]);

const oracleAbi = parseAbi([
  "struct PricePairState { uint256 pairPrice; uint256 basePrice; uint256 quotePrice; uint256 baseCumulativePrice; uint256 quoteCumulativePrice; uint64 baseTimestamp; uint64 quoteTimestamp; }",
  "function oraclePricePairState(uint8 oracleType, string base, string quote) view returns (PricePairState)",
]);

/** ChoiceAggregator.Kind.Adapter: launch-curve venues a USDC to INJ swap never needs. */
const KIND_ADAPTER = 5;
const PERMIT2_TTL_SEC = 15 * 60;
/** USDC asked for above the oracle value of the INJ missing, for fees and impact. */
const SWAP_BUFFER_BPS = 300n;
/** The aggregator swap's gas floor: Helix and split routes measured 0.5M to 3.1M. */
const SWAP_GAS_FLOOR = 1_500_000n;
const SKIP_LOG_EVERY_MS = 60 * 60_000;

export interface KeeperConfig {
  receiver: Address;
  usdc: Address;
  floatLowWei: bigint;
  floatTargetWei: bigint;
  relayerLowWei: bigint;
  relayerTargetWei: bigint;
  /** USDC base units. */
  minSwapUsdc: bigint;
  maxSwapUsdc: bigint;
  /** Slippage asked of /route. */
  slippageBps: number;
  /** The route's minimum may sit at most this far under the oracle value. */
  oracleFloorBps: number;
  oracleMaxAgeSec: number;
}

export interface KeeperState {
  floatWei: bigint;
  relayerWei: bigint;
  relayerUsdc: bigint;
  accruedFees: bigint;
}

export interface RefillPlan {
  floatNeedWei: bigint;
  relayerNeedWei: bigint;
  /** USDC to swap to INJ; 0 when the relayer's surplus covers the float. */
  swapUsdc: bigint;
  /** Of that, what to sweep from the receiver's fees first. */
  sweepUsdc: bigint;
  /** Why the INJ missing will not all be bought this tick. */
  shortfall?: string;
}

/**
 * What to do about the balances, or null when nothing is under its low mark.
 * `injUsd1e18` is the oracle's INJ price, or null when it is unusable, in
 * which case nothing is bought and only the relayer's surplus can move.
 */
export function planRefill(s: KeeperState, cfg: KeeperConfig, injUsd1e18: bigint | null): RefillPlan | null {
  const floatNeedWei = s.floatWei < cfg.floatLowWei ? cfg.floatTargetWei - s.floatWei : 0n;
  const relayerNeedWei = s.relayerWei < cfg.relayerLowWei ? cfg.relayerTargetWei - s.relayerWei : 0n;
  if (floatNeedWei === 0n && relayerNeedWei === 0n) return null;

  const surplus = s.relayerWei > cfg.relayerTargetWei ? s.relayerWei - cfg.relayerTargetWei : 0n;
  const toBuyWei = relayerNeedWei + floatNeedWei - min(floatNeedWei, surplus);
  const plan: RefillPlan = { floatNeedWei, relayerNeedWei, swapUsdc: 0n, sweepUsdc: 0n };
  if (toBuyWei === 0n) return plan;
  if (injUsd1e18 === null) return { ...plan, shortfall: "no usable INJ price" };

  // INJ wei × USD/INJ (1e18) → USD 1e36 → USDC base units (1e6), rounded up.
  const valueUsdc = ceilDiv(toBuyWei * injUsd1e18 * (10_000n + SWAP_BUFFER_BPS), 10n ** 30n * 10_000n);
  let swapUsdc = min(max(valueUsdc, cfg.minSwapUsdc), cfg.maxSwapUsdc);
  const available = s.relayerUsdc + s.accruedFees;
  if (available < cfg.minSwapUsdc) {
    return { ...plan, shortfall: `fees ${formatUnits(available, 6)} USDC are under the ${formatUnits(cfg.minSwapUsdc, 6)} minimum swap` };
  }
  let shortfall: string | undefined;
  if (available < swapUsdc) {
    shortfall = `fees ${formatUnits(available, 6)} USDC cover part of the ${formatUnits(swapUsdc, 6)} needed`;
    swapUsdc = available;
  } else if (valueUsdc > cfg.maxSwapUsdc) {
    shortfall = `capped at ${formatUnits(cfg.maxSwapUsdc, 6)} USDC a tick`;
  }
  const sweepUsdc = swapUsdc > s.relayerUsdc ? swapUsdc - s.relayerUsdc : 0n;
  return { ...plan, swapUsdc, sweepUsdc, ...(shortfall ? { shortfall } : {}) };
}

/** The INJ (wei) `usdc` base units are worth at the oracle price. */
export function injForUsdc(usdc: bigint, injUsd1e18: bigint): bigint {
  return (usdc * 10n ** 30n) / injUsd1e18;
}

/** What Choice's `GET /route` answers, as far as the keeper reads it. */
export interface RouteAnswer {
  tx: { to: string; data: Hex; value: string };
  spender: string;
  amountOut: string;
  legs?: { venue: string }[];
}

export interface RouteExpectation {
  aggregator: Address;
  usdc: Address;
  amountIn: bigint;
  recipient: Address;
  minOutFloor: bigint;
  nowSec: number;
}

/**
 * Refuse any route but the swap we asked for. The aggregator enforces
 * `minimumReceive` on what `recipient` gets, so with the recipient, the
 * input and the fee pinned here, and the minimum held to the oracle's value,
 * the most a wrong or hostile /route answer can cost is that floor's margin.
 */
export function checkRoute(r: RouteAnswer, e: RouteExpectation): void {
  const fail = (why: string): never => {
    throw new Error(`refusing route: ${why}`);
  };
  if (getAddress(r.tx.to) !== getAddress(e.aggregator)) fail(`target ${r.tx.to} is not the aggregator`);
  if (getAddress(r.spender) !== getAddress(e.aggregator)) fail(`spender ${r.spender} is not the aggregator`);
  if (BigInt(r.tx.value) !== 0n) fail(`value ${r.tx.value} on a USDC input`);

  let p: ReturnType<typeof decodeExecute>;
  try {
    p = decodeExecute(r.tx.data);
  } catch {
    return fail("calldata is not execute(RouteParams)");
  }
  if (getAddress(p.currencyIn) !== getAddress(e.usdc)) fail(`currencyIn ${p.currencyIn} is not USDC`);
  if (p.currencyOut !== zeroAddress) fail(`currencyOut ${p.currencyOut} is not native INJ`);
  if (p.amountIn !== e.amountIn) fail(`amountIn ${p.amountIn} is not ${e.amountIn}`);
  if (getAddress(p.recipient) !== getAddress(e.recipient)) fail(`recipient ${p.recipient} is not the relayer`);
  if (p.feeBps !== 0 || p.feeRecipient !== zeroAddress) fail(`route charges a fee (${p.feeBps} bps)`);
  if (p.minimumReceive < e.minOutFloor) fail(`minimum ${p.minimumReceive} is under the oracle floor ${e.minOutFloor}`);
  // /route sets 30 minutes; the minimum still guards a late fill.
  const deadline = Number(p.deadline);
  if (deadline < e.nowSec || deadline > e.nowSec + 3600) fail(`deadline ${deadline} is not within the hour`);
  if (p.steps.length === 0) fail("no steps");
  if (p.steps.some((s) => s.kind === KIND_ADAPTER)) fail("route uses an adapter step");
}

function decodeExecute(data: Hex) {
  return decodeFunctionData({ abi: aggregatorAbi, data }).args[0];
}

export interface KeeperStatus {
  floatInj: string | null;
  accruedFeesUsdc: string | null;
  lastRefillAt: string | null;
  lastIssue: string | null;
}

export interface KeeperDeps {
  cfg: KeeperConfig;
  injective: EvmChain;
  client: PublicClient;
  wallet: WalletClient & { account: Account };
  aggregator: Address;
  permit2: Address;
  fetchRoute: (q: { tokenIn: Address; tokenOut: Address; amountIn: bigint; slippageBps: number; recipient: Address }) => Promise<RouteAnswer>;
  log: Logger;
  now: () => number;
}

export class Keeper {
  private last: KeeperStatus = { floatInj: null, accruedFeesUsdc: null, lastRefillAt: null, lastIssue: null };
  private skipLoggedAt = new Map<string, number>();

  constructor(private readonly d: KeeperDeps) {}

  status(): KeeperStatus {
    return this.last;
  }

  /** One pass. Returns true when it moved anything. */
  async tick(): Promise<boolean> {
    const { cfg } = this.d;
    const me = this.d.wallet.account.address;
    const state = await this.readState();
    this.last = {
      ...this.last,
      floatInj: formatEther(state.floatWei),
      accruedFeesUsdc: formatUnits(state.accruedFees, 6),
    };

    // Without a price the plan can only report that INJ has to be bought;
    // the oracle is read only then.
    const unpriced = planRefill(state, cfg, null);
    this.last.lastIssue = null;
    if (!unpriced) return false;
    const price = unpriced.shortfall ? await this.injPrice() : null;
    const plan = price === null ? unpriced : planRefill(state, cfg, price)!;
    // Without a price, injPrice() has already said why.
    if (plan.shortfall && price !== null) {
      this.issue(plan.shortfall, { float: formatEther(state.floatWei), relayer: formatEther(state.relayerWei) });
    }

    let moved = false;
    if (plan.swapUsdc > 0n && price !== null) {
      try {
        if (plan.sweepUsdc > 0n) {
          await this.send(cfg.receiver, encodeFunctionData({ abi: bridgeReceiverAbi, functionName: "sweepFees", args: [plan.sweepUsdc, me] }));
          this.d.log.info("keeper: fees swept", { usdc: formatUnits(plan.sweepUsdc, 6) });
          moved = true;
        }
        await this.swap(plan.swapUsdc, price);
        moved = true;
      } catch (e) {
        // Swept USDC stays with the relayer and is spent first next time.
        this.issue("swap failed", { error: shortError(e) });
      }
    }

    if (plan.floatNeedWei > 0n) {
      const relayerWei = await this.d.client.getBalance({ address: me });
      const spare = relayerWei > cfg.relayerTargetWei ? relayerWei - cfg.relayerTargetWei : 0n;
      const send = min(plan.floatNeedWei, spare);
      if (send > 0n) {
        await this.send(cfg.receiver, "0x", send);
        this.d.log.info("keeper: float funded", { inj: formatEther(send) });
        moved = true;
      }
    }
    if (moved) this.last.lastRefillAt = new Date(this.d.now()).toISOString();
    return moved;
  }

  private readState(): Promise<KeeperState> {
    return readKeeperState(this.d.client, this.d.cfg, this.d.wallet.account.address);
  }

  /** INJ/USD (1e18) from the chain's oracle, or null when stale or unreadable. */
  private async injPrice(): Promise<bigint | null> {
    try {
      const { price, observedSec } = await readInjUsd(this.d.client);
      const age = this.d.now() / 1000 - observedSec;
      if (price === 0n || age > this.d.cfg.oracleMaxAgeSec) {
        this.issue("INJ oracle price is stale", { ageSec: Math.round(age) });
        return null;
      }
      return price;
    } catch (e) {
      this.issue("INJ oracle unreadable", { error: shortError(e) });
      return null;
    }
  }

  private async swap(amountIn: bigint, injUsd1e18: bigint): Promise<void> {
    const { cfg } = this.d;
    const me = this.d.wallet.account.address;
    const minOutFloor = (injForUsdc(amountIn, injUsd1e18) * BigInt(10_000 - cfg.oracleFloorBps)) / 10_000n;
    const route = await this.d.fetchRoute({
      tokenIn: cfg.usdc,
      tokenOut: zeroAddress,
      amountIn,
      slippageBps: cfg.slippageBps,
      recipient: me,
    });
    checkRoute(route, {
      aggregator: this.d.aggregator,
      usdc: cfg.usdc,
      amountIn,
      recipient: me,
      minOutFloor,
      nowSec: Math.floor(this.d.now() / 1000),
    });
    await this.ensurePermit2(amountIn);

    const before = await this.d.client.getBalance({ address: me });
    const hash = await this.send(this.d.aggregator, route.tx.data, 0n, SWAP_GAS_FLOOR);
    const after = await this.d.client.getBalance({ address: me });
    this.d.log.info("keeper: swapped", {
      usdc: formatUnits(amountIn, 6),
      injQuoted: formatEther(BigInt(route.amountOut)),
      injNet: formatEther(after - before),
      venues: route.legs?.map((l) => l.venue),
      hash,
    });
  }

  /**
   * Let the aggregator pull exactly `amount` of USDC through Permit2: an exact
   * ERC20 grant to Permit2 and an exact, 15-minute Permit2 grant to the
   * aggregator, both spent to zero by the swap (trippy-mcp's rule).
   */
  private async ensurePermit2(amount: bigint): Promise<void> {
    const { cfg, client, permit2, aggregator } = this.d;
    const me = this.d.wallet.account.address;
    const erc20Allowance = await client.readContract({ address: cfg.usdc, abi: erc20Abi, functionName: "allowance", args: [me, permit2] });
    if (erc20Allowance < amount) {
      await this.send(cfg.usdc, encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [permit2, amount] }));
    }
    const nowSec = Math.floor(this.d.now() / 1000);
    const [granted, expiration] = await client.readContract({
      address: permit2,
      abi: permit2Abi,
      functionName: "allowance",
      args: [me, cfg.usdc, aggregator],
    });
    if (granted < amount || Number(expiration) < nowSec + 600) {
      await this.send(
        permit2,
        encodeFunctionData({ abi: permit2Abi, functionName: "approve", args: [cfg.usdc, aggregator, amount, nowSec + PERMIT2_TTL_SEC] }),
      );
    }
  }

  /** Send and wait. Gas is twice the estimate (Injective under-estimates), at least `gasFloor`. */
  private async send(to: Address, data: Hex, value = 0n, gasFloor = 0n): Promise<Hex> {
    const { client, wallet, injective } = this.d;
    const account = wallet.account;
    const estimate = await client.estimateGas({ account: account.address, to, data, value });
    const gas = max(estimate * 2n, gasFloor);
    const fees = await feeOverrides(client, injective, 0n);
    const hash = await wallet.sendTransaction({ account, chain: null, to, data, value, gas, ...fees });
    const receipt = await client.waitForTransactionReceipt({ hash, timeout: 90_000 });
    if (receipt.status !== "success") throw new Error(`keeper tx reverted ${hash}`);
    return hash;
  }

  /** Record a problem for /v1/health and log it at most hourly. */
  private issue(why: string, fields: Record<string, unknown> = {}): void {
    this.last.lastIssue = why;
    const now = this.d.now();
    const at = this.skipLoggedAt.get(why) ?? 0;
    if (now - at < SKIP_LOG_EVERY_MS) return;
    this.skipLoggedAt.set(why, now);
    this.d.log.warn(`keeper: ${why}`, fields);
  }
}

export async function readKeeperState(client: PublicClient, cfg: Pick<KeeperConfig, "receiver" | "usdc">, relayer: Address): Promise<KeeperState> {
  const [floatWei, relayerWei, relayerUsdc, accruedFees] = await Promise.all([
    client.getBalance({ address: cfg.receiver }),
    client.getBalance({ address: relayer }),
    client.readContract({ address: cfg.usdc, abi: erc20Abi, functionName: "balanceOf", args: [relayer] }),
    client.readContract({ address: cfg.receiver, abi: bridgeReceiverAbi, functionName: "accruedFees" }),
  ]);
  return { floatWei, relayerWei, relayerUsdc, accruedFees };
}

/** INJ/USD (1e18) and when it was observed (unix seconds), from the oracle precompile. */
export async function readInjUsd(client: PublicClient): Promise<{ price: bigint; observedSec: number }> {
  const s = await client.readContract({
    address: INJ_USD_ORACLE.precompile,
    abi: oracleAbi,
    functionName: "oraclePricePairState",
    args: [INJ_USD_ORACLE.oracleType, INJ_USD_ORACLE.base, INJ_USD_ORACLE.quote],
  });
  // Read pairPrice, never basePrice (zero for PriceFeed pairs). A pair is as
  // fresh as its staler leg; a zero timestamp is a leg that has none.
  const stamps = [s.baseTimestamp, s.quoteTimestamp].filter((t) => t > 0n);
  const observedSec = stamps.length ? Number(stamps.reduce((a, b) => (a < b ? a : b))) : 0;
  return { price: s.pairPrice, observedSec };
}

/** Choice's `GET /route`, for a USDC to native INJ refill. */
export function routeApi(baseUrl: string): KeeperDeps["fetchRoute"] {
  return async (q) => {
    const url = new URL("/route", baseUrl);
    url.searchParams.set("tokenIn", q.tokenIn);
    url.searchParams.set("tokenOut", q.tokenOut);
    url.searchParams.set("amountIn", q.amountIn.toString());
    url.searchParams.set("slippageBps", String(q.slippageBps));
    url.searchParams.set("recipient", q.recipient);
    const res = await fetch(url, { headers: { "X-Client": "injective-usdc-bridge" }, signal: AbortSignal.timeout(20_000) });
    const body = (await res.json().catch(() => ({}))) as RouteAnswer & { error?: string };
    if (!res.ok || !body.tx) throw new Error(`route api ${res.status}: ${body.error ?? "no route"}`);
    return body;
  };
}

function min(a: bigint, b: bigint): bigint {
  return a < b ? a : b;
}
function max(a: bigint, b: bigint): bigint {
  return a > b ? a : b;
}
function ceilDiv(a: bigint, b: bigint): bigint {
  return (a + b - 1n) / b;
}
function shortError(e: unknown): string {
  const err = e as { shortMessage?: string; message?: string };
  return (err.shortMessage ?? err.message ?? String(e)).split("\n")[0]!.slice(0, 300);
}

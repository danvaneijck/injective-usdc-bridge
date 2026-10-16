import { type Address, type Hex, decodeFunctionData, encodeFunctionData, parseEther, parseUnits, zeroAddress } from "viem";
import { describe, expect, it } from "vitest";
import { bridgeReceiverAbi, erc20Abi, injective } from "injective-usdc-bridge";
import {
  Keeper,
  type KeeperConfig,
  type RouteAnswer,
  aggregatorAbi,
  checkRoute,
  injForUsdc,
  planRefill,
} from "../src/keeper.js";
import { silentLogger } from "../src/log.js";

const inj = injective("mainnet");
const USDC = inj.usdc;
const RECEIVER: Address = "0xcA5A96ECF72B3656eF7cF60BDAA42FCdb218cd4A";
const RELAYER: Address = "0xeEB5b86ACAe1Ee3199821540C5d4Fa803a6E1566";
const AGGREGATOR: Address = "0xa705d0D5f549Af25024038dc575E3074B9Bd37c9";
const PERMIT2: Address = "0x000000000022D473030F116dDEE9F6B43aC78BA3";
const WINJ: Address = "0x0000000088827d2d103ee2d9A6b781773AE03FfB";
const ATTACKER: Address = "0x000000000000000000000000000000000000dEaD";
const PRICE = parseEther("9.13"); // USD per INJ, 1e18
const NOW_MS = 1_792_156_894_000;

const cfg: KeeperConfig = {
  receiver: RECEIVER,
  usdc: USDC,
  floatLowWei: parseEther("0.04"),
  floatTargetWei: parseEther("0.06"),
  relayerLowWei: parseEther("0.03"),
  relayerTargetWei: parseEther("0.05"),
  minSwapUsdc: parseUnits("0.5", 6),
  maxSwapUsdc: parseUnits("5", 6),
  slippageBps: 100,
  oracleFloorBps: 300,
  oracleMaxAgeSec: 300,
};

const state = (o: Partial<{ float: string; relayer: string; usdc: string; fees: string }>) => ({
  floatWei: parseEther(o.float ?? "0.05"),
  relayerWei: parseEther(o.relayer ?? "0.05"),
  relayerUsdc: parseUnits(o.usdc ?? "0", 6),
  accruedFees: parseUnits(o.fees ?? "0", 6),
});

describe("planRefill", () => {
  it("does nothing while both balances sit above their low marks", () => {
    expect(planRefill(state({}), cfg, PRICE)).toBeNull();
  });

  it("buys at least the minimum swap for a low float, sweeping only what the relayer lacks", () => {
    const p = planRefill(state({ float: "0.03", fees: "0.5" }), cfg, PRICE)!;
    expect(p.floatNeedWei).toBe(parseEther("0.03"));
    expect(p.swapUsdc).toBe(parseUnits("0.5", 6)); // 0.03 INJ is ~$0.28, under the minimum
    expect(p.sweepUsdc).toBe(parseUnits("0.5", 6));
    const held = planRefill(state({ float: "0.03", fees: "0.5", usdc: "0.2" }), cfg, PRICE)!;
    expect(held.sweepUsdc).toBe(parseUnits("0.3", 6));
  });

  it("refills the float from the relayer's surplus without a swap", () => {
    const p = planRefill(state({ float: "0.03", relayer: "0.09" }), cfg, null)!;
    expect(p).toMatchObject({ swapUsdc: 0n, sweepUsdc: 0n });
    expect(p.shortfall).toBeUndefined();
  });

  it("says why it cannot buy: no price, too few fees, or the per-tick cap", () => {
    expect(planRefill(state({ relayer: "0.01", fees: "9" }), cfg, null)!.shortfall).toMatch(/no usable INJ price/);
    const poor = planRefill(state({ relayer: "0.01", fees: "0.1" }), cfg, PRICE)!;
    expect(poor).toMatchObject({ swapUsdc: 0n });
    expect(poor.shortfall).toMatch(/under the 0.5 minimum/);
    const big = { ...cfg, relayerTargetWei: parseEther("2"), relayerLowWei: parseEther("1") };
    const capped = planRefill(state({ relayer: "0", fees: "100" }), big, PRICE)!;
    expect(capped.swapUsdc).toBe(cfg.maxSwapUsdc);
    expect(capped.shortfall).toMatch(/capped/);
  });

  it("prices INJ at the oracle with a 3% buffer", () => {
    const p = planRefill(state({ relayer: "0", fees: "5" }), cfg, PRICE)!;
    // 0.05 INJ × $9.13 × 1.03 = $0.4702, under the 0.5 minimum; 0.1 INJ is not.
    expect(p.swapUsdc).toBe(parseUnits("0.5", 6));
    const two = planRefill(state({ relayer: "0", float: "0", fees: "5" }), cfg, PRICE)!;
    expect(two.swapUsdc).toBe(parseUnits("1.034429", 6)); // 0.11 INJ × 9.13 × 1.03
  });
});

function route(over: Partial<{ to: Address; spender: Address; value: string; recipient: Address; currencyOut: Address; amountIn: bigint; minimumReceive: bigint; feeBps: number; feeRecipient: Address; deadline: bigint; kinds: number[] }> = {}): RouteAnswer {
  const amountIn = over.amountIn ?? parseUnits("0.5", 6);
  const out = injForUsdc(parseUnits("0.5", 6), PRICE);
  const data = encodeFunctionData({
    abi: aggregatorAbi,
    functionName: "execute",
    args: [
      {
        currencyIn: USDC,
        currencyOut: over.currencyOut ?? zeroAddress,
        amountIn,
        minimumReceive: over.minimumReceive ?? (out * 99n) / 100n,
        recipient: over.recipient ?? RELAYER,
        deadline: over.deadline ?? BigInt(NOW_MS / 1000 + 300),
        feeBps: over.feeBps ?? 0,
        feeRecipient: over.feeRecipient ?? zeroAddress,
        steps: (over.kinds ?? [2, 1]).map((kind) => ({ kind, tokenIn: USDC, tokenOut: WINJ, shareBps: 10_000, data: "0x" as Hex })),
      },
    ],
  });
  return { tx: { to: over.to ?? AGGREGATOR, data, value: over.value ?? "0" }, spender: over.spender ?? AGGREGATOR, amountOut: out.toString() };
}

describe("checkRoute", () => {
  const expectation = {
    aggregator: AGGREGATOR,
    usdc: USDC,
    amountIn: parseUnits("0.5", 6),
    recipient: RELAYER,
    minOutFloor: (injForUsdc(parseUnits("0.5", 6), PRICE) * 97n) / 100n,
    nowSec: NOW_MS / 1000,
  };

  it("accepts the swap we asked for", () => {
    expect(() => checkRoute(route(), expectation)).not.toThrow();
  });

  it.each([
    ["another target", { to: ATTACKER }, /not the aggregator/],
    ["another spender", { spender: ATTACKER }, /spender/],
    ["native value", { value: "1" }, /value/],
    ["paying someone else", { recipient: ATTACKER }, /recipient/],
    ["wINJ instead of INJ", { currencyOut: WINJ }, /native INJ/],
    ["a different input", { amountIn: parseUnits("5", 6) }, /amountIn/],
    ["a fee", { feeBps: 50, feeRecipient: ATTACKER }, /fee/],
    ["a minimum under the oracle floor", { minimumReceive: 1n }, /oracle floor/],
    ["a far deadline", { deadline: BigInt(NOW_MS / 1000 + 7200) }, /deadline/],
    ["a past deadline", { deadline: BigInt(NOW_MS / 1000 - 1) }, /deadline/],
    ["an adapter step", { kinds: [2, 5] }, /adapter/],
  ])("refuses %s", (_, over, why) => {
    expect(() => checkRoute(route(over), expectation)).toThrow(why);
  });

  it("refuses calldata that is not execute(RouteParams)", () => {
    const r = route();
    expect(() => checkRoute({ ...r, tx: { ...r.tx, data: "0xdeadbeef" } }, expectation)).toThrow(/not execute/);
  });
});

/** A chain whose balances move as the keeper's transactions land. */
function fakeChain(o: { float: string; relayer: string; usdc?: string; fees?: string; oracleAgeSec?: number }) {
  const s = {
    floatWei: parseEther(o.float),
    relayerWei: parseEther(o.relayer),
    relayerUsdc: parseUnits(o.usdc ?? "0", 6),
    fees: parseUnits(o.fees ?? "0", 6),
    erc20Allowance: 0n,
    permit2Allowance: 0n,
    permit2Expiry: 0,
  };
  const sent: string[] = [];
  const client = {
    getBalance: async ({ address }: { address: Address }) => (address === RECEIVER ? s.floatWei : s.relayerWei),
    readContract: async ({ address, functionName }: { address: Address; functionName: string }) => {
      if (functionName === "accruedFees") return s.fees;
      if (functionName === "balanceOf") return s.relayerUsdc;
      if (functionName === "allowance") {
        return address === PERMIT2 ? [s.permit2Allowance, s.permit2Expiry, 0] : s.erc20Allowance;
      }
      if (functionName === "oraclePricePairState") {
        const t = BigInt(Math.floor(NOW_MS / 1000) - (o.oracleAgeSec ?? 2));
        return { pairPrice: PRICE, basePrice: PRICE, quotePrice: 0n, baseCumulativePrice: 0n, quoteCumulativePrice: 0n, baseTimestamp: t, quoteTimestamp: t };
      }
      throw new Error(`unexpected read ${functionName}`);
    },
    estimateGas: async () => 100_000n,
    getBlock: async () => ({ baseFeePerGas: 160_000_000n }),
    estimateMaxPriorityFeePerGas: async () => 0n,
    waitForTransactionReceipt: async () => ({ status: "success" }),
  };
  const wallet = {
    account: { address: RELAYER },
    sendTransaction: async (tx: { to: Address; data: Hex; value: bigint }) => {
      if (tx.to === RECEIVER && tx.value > 0n) {
        sent.push("fund float");
        s.floatWei += tx.value;
        s.relayerWei -= tx.value;
      } else if (tx.to === RECEIVER) {
        const { args } = decodeFunctionData({ abi: bridgeReceiverAbi, data: tx.data });
        sent.push("sweepFees");
        s.fees -= args![0] as bigint;
        s.relayerUsdc += args![0] as bigint;
      } else if (tx.to === USDC) {
        const { args } = decodeFunctionData({ abi: erc20Abi, data: tx.data });
        sent.push("approve permit2");
        s.erc20Allowance = args![1] as bigint;
      } else if (tx.to === PERMIT2) {
        sent.push("permit2 grant");
        s.permit2Allowance = parseUnits("1000", 6);
        s.permit2Expiry = NOW_MS / 1000 + 900;
      } else if (tx.to === AGGREGATOR) {
        const p = decodeFunctionData({ abi: aggregatorAbi, data: tx.data }).args[0];
        sent.push("swap");
        s.relayerUsdc -= p.amountIn;
        s.relayerWei += injForUsdc(p.amountIn, PRICE);
      }
      return `0x${"ab".repeat(32)}` as Hex;
    },
  };
  return { s, sent, client, wallet };
}

function keeperOn(chain: ReturnType<typeof fakeChain>, fetchRoute: () => Promise<RouteAnswer> = async () => route()) {
  return new Keeper({
    cfg,
    injective: inj,
    client: chain.client as never,
    wallet: chain.wallet as never,
    aggregator: AGGREGATOR,
    permit2: PERMIT2,
    fetchRoute,
    log: silentLogger,
    now: () => NOW_MS,
  });
}

describe("Keeper", () => {
  it("leaves healthy balances alone", async () => {
    const chain = fakeChain({ float: "0.05", relayer: "0.05", fees: "3" });
    expect(await keeperOn(chain).tick()).toBe(false);
    expect(chain.sent).toEqual([]);
  });

  it("refills the float after a drop: sweep, approve, swap, fund", async () => {
    const chain = fakeChain({ float: "0.03", relayer: "0.05", fees: "0.5" });
    const keeper = keeperOn(chain);
    expect(await keeper.tick()).toBe(true);
    expect(chain.sent).toEqual(["sweepFees", "approve permit2", "permit2 grant", "swap", "fund float"]);
    expect(chain.s.floatWei).toBe(parseEther("0.06"));
    expect(chain.s.fees).toBe(0n);
    // The relayer keeps what the swap bought beyond the float's share.
    expect(chain.s.relayerWei).toBe(parseEther("0.05") + injForUsdc(parseUnits("0.5", 6), PRICE) - parseEther("0.03"));
    expect(keeper.status()).toMatchObject({ lastIssue: null, floatInj: "0.03" });
  });

  it("buys nothing on a stale oracle price, and says so", async () => {
    const chain = fakeChain({ float: "0.03", relayer: "0.05", fees: "0.5", oracleAgeSec: 3600 });
    const keeper = keeperOn(chain);
    expect(await keeper.tick()).toBe(false);
    expect(chain.sent).toEqual([]);
    expect(keeper.status().lastIssue).toMatch(/stale/);
  });

  it("refuses a hostile route, keeps the swept fees, and spends them on the next good one", async () => {
    const chain = fakeChain({ float: "0.03", relayer: "0.05", fees: "0.5" });
    let hostile = true;
    const keeper = keeperOn(chain, async () => (hostile ? route({ recipient: ATTACKER }) : route()));
    await keeper.tick();
    expect(chain.sent).toEqual(["sweepFees"]);
    expect(keeper.status().lastIssue).toBe("swap failed");
    expect(chain.s.relayerUsdc).toBe(parseUnits("0.5", 6));

    hostile = false;
    chain.sent.length = 0;
    await keeper.tick();
    expect(chain.sent).toEqual(["approve permit2", "permit2 grant", "swap", "fund float"]);
    expect(chain.s.floatWei).toBe(parseEther("0.06"));
  });
});

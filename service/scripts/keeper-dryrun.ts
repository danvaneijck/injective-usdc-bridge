/**
 * Keeper dry run against mainnet. Reads the float, the relayer's balances and
 * the receiver's fees, prices INJ with the chain's oracle, prints the refill
 * plan, then fetches a live /route answer for `usdc` and vets it exactly as
 * the keeper would before signing. Sends nothing and needs no key.
 *
 *   tsx scripts/keeper-dryrun.ts [relayer] [usdc]
 */
import { type Address, createPublicClient, formatEther, formatUnits, getAddress, http, parseUnits } from "viem";
import { BRIDGE_RECEIVER, injective } from "injective-usdc-bridge";
import { loadConfig } from "../src/config.js";
import {
  CHOICE_MAINNET,
  checkRoute,
  injForUsdc,
  planRefill,
  readInjUsd,
  readKeeperState,
  routeApi,
} from "../src/keeper.js";

const relayer = getAddress(process.argv[2] ?? "0xeEB5b86ACAe1Ee3199821540C5d4Fa803a6E1566") as Address;
const amountIn = parseUnits(process.argv[3] ?? "0.5", 6);
const k = loadConfig({ ...process.env, NETWORK: "mainnet" }).keeper;
const inj = injective("mainnet");
const client = createPublicClient({ transport: http(process.env.RPC_29 ?? inj.rpcUrls[0]) });
const cfg = {
  receiver: BRIDGE_RECEIVER.mainnet!,
  usdc: inj.usdc,
  floatLowWei: k.floatLowWei,
  floatTargetWei: k.floatTargetWei,
  relayerLowWei: k.relayerLowWei,
  relayerTargetWei: k.relayerTargetWei,
  minSwapUsdc: k.minSwapUsdc,
  maxSwapUsdc: k.maxSwapUsdc,
  slippageBps: k.slippageBps,
  oracleFloorBps: 300,
  oracleMaxAgeSec: 300,
};

const s = await readKeeperState(client, cfg, relayer);
const { price, observedSec } = await readInjUsd(client);
console.log({
  float: formatEther(s.floatWei),
  relayer: formatEther(s.relayerWei),
  relayerUsdc: formatUnits(s.relayerUsdc, 6),
  accruedFees: formatUnits(s.accruedFees, 6),
  injUsd: formatEther(price),
  oracleAgeSec: Math.round(Date.now() / 1000 - observedSec),
});
const plan = planRefill(s, cfg, price);
console.log(
  "plan:",
  plan && {
    floatNeed: formatEther(plan.floatNeedWei),
    relayerNeed: formatEther(plan.relayerNeedWei),
    swapUsdc: formatUnits(plan.swapUsdc, 6),
    sweepUsdc: formatUnits(plan.sweepUsdc, 6),
    shortfall: plan.shortfall,
  },
);

const route = await routeApi(k.routeApi)({ tokenIn: inj.usdc, tokenOut: "0x0000000000000000000000000000000000000000", amountIn, slippageBps: cfg.slippageBps, recipient: relayer });
const minOutFloor = (injForUsdc(amountIn, price) * BigInt(10_000 - cfg.oracleFloorBps)) / 10_000n;
checkRoute(route, {
  aggregator: CHOICE_MAINNET.aggregator,
  usdc: inj.usdc,
  amountIn,
  recipient: relayer,
  minOutFloor,
  nowSec: Math.floor(Date.now() / 1000),
});
console.log("route vetted:", {
  usdcIn: formatUnits(amountIn, 6),
  injQuoted: formatEther(BigInt(route.amountOut)),
  injAtOracle: formatEther(injForUsdc(amountIn, price)),
  oracleFloor: formatEther(minOutFloor),
  venues: route.legs?.map((l) => l.venue),
});

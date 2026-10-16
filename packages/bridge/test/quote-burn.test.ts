import { decodeFunctionData, getAddress, isAddress } from "viem";
import { describe, expect, it } from "vitest";
import { erc20Abi, tokenMessengerV2Abi } from "../src/abis.js";
import { buildBurn } from "../src/burn.js";
import { type Chain, chainByKey, chains, injective, peers } from "../src/chains.js";
import { CCTP_CONTRACTS, ZERO_BYTES32 } from "../src/constants.js";
import { FORWARD_HOOK_DATA } from "../src/hookData.js";
import type { IrisClient, IrisFeeTier } from "../src/iris.js";
import { bpsFee, quoteTransfer, RouteError } from "../src/quote.js";

const RECIPIENT = getAddress("0x73fcb2d05f2e29561b58177af7f22ac19b3b484f");

function stubIris(tiers: IrisFeeTier[]): IrisClient {
  return { getFees: async () => tiers } as unknown as IrisClient;
}

const chain = (key: string): Chain => {
  const c = chainByKey("mainnet", key);
  if (!c) throw new Error(key);
  return c;
};

describe("registry", () => {
  it.each(["mainnet", "testnet"] as const)("%s has unique domains, chain ids and keys", (n) => {
    const all = chains(n);
    expect(new Set(all.map((c) => c.domain)).size).toBe(all.length);
    expect(new Set(all.map((c) => c.key)).size).toBe(all.length);
    const evm = all.filter((c) => c.kind === "evm");
    expect(new Set(evm.map((c) => c.chainId)).size).toBe(evm.length);
    expect(all.every((c) => c.rpcUrls.length > 0)).toBe(true);
    expect(injective(n).chainId).toBe(n === "mainnet" ? 1776 : 1439);
  });

  it.each(["mainnet", "testnet"] as const)("%s USDC addresses are valid EIP-55", (n) => {
    for (const c of chains(n)) {
      if (c.kind === "evm") expect(isAddress(c.usdc, { strict: true }), c.key).toBe(true);
    }
  });

  it("Circle cannot forward to Injective, so inbound needs our relayer", () => {
    expect(injective("mainnet").forwarding).toBe(false);
    expect(peers("mainnet").some((c) => c.domain === 29)).toBe(false);
  });
});

describe("bpsFee", () => {
  it("handles fractional bps and rounds up", () => {
    expect(bpsFee(1_000_000n, 1.3)).toBe(130n);
    expect(bpsFee(1n, 1)).toBe(1n);
    expect(bpsFee(1_000_000n, 0)).toBe(0n);
  });
});

describe("quoteTransfer", () => {
  it("deposit from Base: fast, buffered protocol fee, no forwarding", async () => {
    const q = await quoteTransfer({
      iris: stubIris([
        { finalityThreshold: 1000, minimumFee: 1.3 },
        { finalityThreshold: 2000, minimumFee: 0 },
      ]),
      route: { source: chain("base"), destination: injective("mainnet") },
      amount: 100_000_000n,
    });
    expect(q.direction).toBe("deposit");
    expect(q.speed).toBe("fast");
    expect(q.minFinalityThreshold).toBe(1000);
    expect(q.protocolFee).toBe(13_000n + 2_600n);
    expect(q.forwarded).toBe(false);
    expect(q.forwardingFee).toBe(0n);
    expect(q.bridgeFee).toBe(0n);
    expect(q.maxFee).toBe(15_600n);
    expect(q.minReceived).toBe(100_000_000n - 15_600n);
  });

  it("withdraw to Base: Circle forwards and the fee covers it", async () => {
    const q = await quoteTransfer({
      iris: stubIris([
        { finalityThreshold: 1000, minimumFee: 0, forwardFee: { low: 53_969, med: 54_131, high: 54_612 } },
        { finalityThreshold: 2000, minimumFee: 0, forwardFee: { low: 53_969, med: 54_131, high: 54_612 } },
      ]),
      route: { source: injective("mainnet"), destination: chain("base") },
      amount: 10_000_000n,
    });
    expect(q.direction).toBe("withdraw");
    expect(q.speed).toBe("standard");
    expect(q.forwarded).toBe(true);
    expect(q.maxFee).toBe(54_131n);
  });

  it("withdraw to Plasma: no forwarding available, relayer backstops", async () => {
    const q = await quoteTransfer({
      iris: stubIris([{ finalityThreshold: 2000, minimumFee: 0 }]),
      route: { source: injective("mainnet"), destination: chain("plasma") },
      amount: 10_000_000n,
    });
    expect(q.forwarded).toBe(false);
    expect(q.maxFee).toBe(0n);
  });

  it("refuses non-Injective routes", async () => {
    await expect(
      quoteTransfer({
        iris: stubIris([]),
        route: { source: chain("base"), destination: chain("arbitrum") },
        amount: 1n,
      }),
    ).rejects.toBeInstanceOf(RouteError);
  });

  it("refuses an amount that cannot cover its fees", async () => {
    await expect(
      quoteTransfer({
        iris: stubIris([
          { finalityThreshold: 2000, minimumFee: 0, forwardFee: { low: 1, med: 1_040_196, high: 2 } },
        ]),
        route: { source: injective("mainnet"), destination: chain("ethereum") },
        amount: 1_000_000n,
      }),
    ).rejects.toThrow(/does not cover fees/);
  });
});

describe("buildBurn", () => {
  const tm = CCTP_CONTRACTS.mainnet.tokenMessenger;

  it("withdraw with forwarding uses depositForBurnWithHook, permissionless", async () => {
    const route = { source: injective("mainnet"), destination: chain("arbitrum") };
    const quote = await quoteTransfer({
      iris: stubIris([
        { finalityThreshold: 2000, minimumFee: 0, forwardFee: { low: 1, med: 60_000, high: 3 } },
      ]),
      route,
      amount: 5_000_000n,
    });
    const plan = buildBurn({ network: "mainnet", route, quote, recipient: RECIPIENT });

    expect(plan.burn.to).toBe(tm);
    const call = decodeFunctionData({ abi: tokenMessengerV2Abi, data: plan.burn.data });
    expect(call.functionName).toBe("depositForBurnWithHook");
    expect(call.args).toEqual([
      5_000_000n,
      3,
      plan.mintRecipient,
      injective("mainnet").usdc,
      ZERO_BYTES32,
      60_000n,
      2000,
      FORWARD_HOOK_DATA,
    ]);

    expect(plan.approve?.to).toBe(injective("mainnet").usdc);
    const approve = decodeFunctionData({ abi: erc20Abi, data: plan.approve!.data });
    expect(approve.args).toEqual([tm, 5_000_000n]);
  });

  it("deposit uses plain depositForBurn and skips approve when allowance suffices", async () => {
    const route = { source: chain("base"), destination: injective("mainnet") };
    const quote = await quoteTransfer({
      iris: stubIris([{ finalityThreshold: 2000, minimumFee: 0 }]),
      route,
      amount: 5_000_000n,
      speed: "standard",
    });
    const plan = buildBurn({
      network: "mainnet",
      route,
      quote,
      recipient: RECIPIENT,
      allowance: 5_000_000n,
    });
    expect(plan.approve).toBeUndefined();
    const call = decodeFunctionData({ abi: tokenMessengerV2Abi, data: plan.burn.data });
    expect(call.functionName).toBe("depositForBurn");
    expect(call.args?.[1]).toBe(29);
    expect(call.args?.[4]).toBe(ZERO_BYTES32);
  });

  it("rejects a quote for the other direction and bad recipients", async () => {
    const out = { source: injective("mainnet"), destination: chain("base") };
    const back = { source: chain("base"), destination: injective("mainnet") };
    const quote = await quoteTransfer({
      iris: stubIris([{ finalityThreshold: 2000, minimumFee: 0 }]),
      route: back,
      amount: 5_000_000n,
      speed: "standard",
    });
    expect(() => buildBurn({ network: "mainnet", route: out, quote, recipient: RECIPIENT })).toThrow(
      /different route/,
    );
    expect(() => buildBurn({ network: "mainnet", route: back, quote, recipient: "inj1abc" })).toThrow(
      /not an EVM address/,
    );
    // A mistyped checksum is refused rather than silently accepted.
    expect(() =>
      buildBurn({
        network: "mainnet",
        route: back,
        quote,
        recipient: "0x73fCB2d05F2E29561B58177Af7F22aC19B3b484F",
      }),
    ).toThrow(/not an EVM address/);
  });

  it("does not build Solana legs yet", async () => {
    const route = { source: injective("mainnet"), destination: chain("solana") };
    const quote = await quoteTransfer({
      iris: stubIris([
        { finalityThreshold: 2000, minimumFee: 0, forwardFee: { low: 1, med: 151_693, high: 3 } },
      ]),
      route,
      amount: 5_000_000n,
    });
    expect(() => buildBurn({ network: "mainnet", route, quote, recipient: RECIPIENT })).toThrow(
      RouteError,
    );
  });
});

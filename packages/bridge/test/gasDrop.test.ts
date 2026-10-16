import { decodeFunctionData, getAddress } from "viem";
import { describe, expect, it } from "vitest";
import { tokenMessengerV2Abi } from "../src/abis.js";
import { buildBurn } from "../src/burn.js";
import { chainByKey, injective } from "../src/chains.js";
import { encodeGasDropHook } from "../src/gasDrop.js";
import type { IrisClient } from "../src/iris.js";
import { addressToBytes32 } from "../src/message.js";
import { quoteTransfer } from "../src/quote.js";

const USER = getAddress("0x73fcb2d05f2e29561b58177af7f22ac19b3b484f");
const RECEIVER = getAddress("0x00000000000000000000000000000000000b1d9e");

/** Same bytes as contracts/test/BridgeReceiver.t.sol test_tsHookVectorParses. */
export const HOOK_VECTOR =
  "0x4955423100000000000000000000000000000000000000000000000000000000" +
  "00000000000000000000000073fcb2d05f2e29561b58177af7f22ac19b3b484f" +
  "000000000000000000000000000000000000000000000000000000000007a120";

const iris = {
  getFees: async () => [{ finalityThreshold: 2000, minimumFee: 0 }],
} as unknown as IrisClient;

const base = chainByKey("mainnet", "base")!;

describe("gas drop", () => {
  it("encodes the hook BridgeReceiver parses", () => {
    expect(encodeGasDropHook(USER, 500_000n)).toBe(HOOK_VECTOR);
  });

  it("pins mint and caller to the receiver and subtracts the drop fee", async () => {
    const route = { source: base, destination: injective("mainnet") };
    const quote = await quoteTransfer({
      iris,
      route,
      amount: 10_000_000n,
      speed: "standard",
      gasDropFee: 250_000n,
    });
    expect(quote.gasDropFee).toBe(250_000n);
    expect(quote.minReceived).toBe(9_750_000n);

    const plan = buildBurn({
      network: "mainnet",
      route,
      quote,
      recipient: USER,
      gasDrop: { receiver: RECEIVER, maxDropFee: 500_000n },
    });
    const call = decodeFunctionData({ abi: tokenMessengerV2Abi, data: plan.burn.data });
    expect(call.functionName).toBe("depositForBurnWithHook");
    expect(call.args?.[2]).toBe(addressToBytes32(RECEIVER));
    expect(call.args?.[4]).toBe(addressToBytes32(RECEIVER));
    expect(call.args?.[7]).toBe(HOOK_VECTOR);
  });

  it("refuses a drop on withdrawals", async () => {
    await expect(
      quoteTransfer({
        iris,
        route: { source: injective("mainnet"), destination: base },
        amount: 10_000_000n,
        forward: false,
        gasDropFee: 1n,
      }),
    ).rejects.toThrow(/only available on deposits/);
  });
});

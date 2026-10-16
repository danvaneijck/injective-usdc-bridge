import type { PublicClient } from "viem";
import { describe, expect, it } from "vitest";
import { chainByKey, injective } from "../src/chains.js";
import { feeOverrides } from "../src/rpc.js";

const client = (baseFee: bigint, tip: bigint) =>
  ({
    getBlock: async () => ({ baseFeePerGas: baseFee }),
    estimateMaxPriorityFeePerGas: async () => tip,
  }) as unknown as PublicClient;

describe("feeOverrides", () => {
  it("Injective: the ceiling is billed in full, so it stays near the base fee", async () => {
    const base = 160_000_000n;
    // Wallet path: MetaMask needs a non-zero tip.
    expect(await feeOverrides(client(base, 0n), injective("mainnet"))).toEqual({
      maxFeePerGas: base + base / 8n + 1_000_000_000n,
      maxPriorityFeePerGas: 1_000_000_000n,
    });
    // Backend signer: no tip at all.
    expect(await feeOverrides(client(base, 0n), injective("mainnet"), 0n)).toEqual({
      maxFeePerGas: 180_000_000n,
      maxPriorityFeePerGas: 0n,
    });
  });

  it("leaves other chains to the wallet", async () => {
    expect(await feeOverrides(client(1n, 1n), chainByKey("mainnet", "base") as never)).toBeUndefined();
  });
});

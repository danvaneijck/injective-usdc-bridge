import type { Hex, PublicClient } from "viem";
import { afterEach, describe, expect, it, vi } from "vitest";
import { usedNonceAddress } from "injective-usdc-bridge";
import { createMintFinder } from "../src/mintFinder.js";

const NONCE = `0x${"11".repeat(32)}` as Hex;
const NOW = 1_800_000_000_000;

/** A chain making a block every second, head at 10_000. */
function chainClient(): PublicClient {
  return {
    getBlockNumber: async () => 10_000n,
    getBlock: async ({ blockNumber }: { blockNumber: bigint }) => ({ timestamp: 1_800_000_000n - (10_000n - blockNumber) }),
  } as unknown as PublicClient;
}

describe("mint finder", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("on an EVM chain, walks back from head in the endpoint's spans, newest first", async () => {
    const ranges: [bigint, bigint][] = [];
    const find = createMintFinder({
      network: "mainnet",
      clientFor: () => chainClient(),
      logOverrides: { 3: [{ url: "logs", span: 100 }] },
      solanaRpcUrls: [],
      now: () => NOW,
      clientForUrl: () =>
        ({
          getLogs: async ({ fromBlock, toBlock, args }: { fromBlock: bigint; toBlock: bigint; args: { nonce: Hex } }) => {
            expect(args.nonce).toBe(NONCE);
            ranges.push([fromBlock, toBlock]);
            return fromBlock <= 9_850n && 9_850n <= toBlock ? [{ transactionHash: `0x${"AB".repeat(32)}` }] : [];
          },
        }) as unknown as PublicClient,
    });
    // Last seen undelivered 4 min ago: 240 blocks plus a minute's margin.
    expect(await find(3, NONCE, NOW - 240_000)).toBe(`0x${"ab".repeat(32)}`);
    expect(ranges).toEqual([
      [9_901n, 10_000n],
      [9_801n, 9_900n],
    ]);
  });

  it("gives up rather than scan more than its budget", async () => {
    const getLogs = vi.fn(async () => []);
    const find = createMintFinder({
      network: "mainnet",
      clientFor: () => chainClient(),
      logOverrides: { 3: [{ url: "logs", span: 100 }] },
      solanaRpcUrls: [],
      now: () => NOW,
      clientForUrl: () => ({ getLogs }) as unknown as PublicClient,
    });
    // A day back is 86k blocks: past every endpoint's budget at its span.
    const registrySpans = await find(3, NONCE, NOW - 86_400_000);
    expect(registrySpans).toBeNull();
    expect(getLogs.mock.calls.length).toBeLessThanOrEqual(6);
  });

  it("on Solana, takes the oldest successful transaction on the nonce's account", async () => {
    const calls: unknown[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: { body: string }) => {
        const body = JSON.parse(init.body) as { method: string; params: unknown[] };
        calls.push(body);
        return new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            result: [
              { signature: "failedRetry", err: { InstructionError: [0, "Custom"] } },
              { signature: "claimSig", err: null },
            ],
          }),
        );
      }),
    );
    const find = createMintFinder({ network: "mainnet", clientFor: () => chainClient(), solanaRpcUrls: ["https://solana.test"], now: () => NOW });
    expect(await find(5, NONCE, NOW - 60_000)).toBe("claimSig");
    expect(calls[0]).toMatchObject({ method: "getSignaturesForAddress", params: [usedNonceAddress(NONCE), { limit: 20 }] });
  });
});

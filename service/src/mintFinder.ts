import { type Hex, type PublicClient, createPublicClient, getAbiItem, http } from "viem";
import { CCTP_CONTRACTS, type EvmChain, type Network, chainByDomain, messageTransmitterV2Abi, solanaRpc, usedNonceAddress } from "injective-usdc-bridge";
import { type LogEndpoint, logEndpoints } from "./indexer.js";

const MESSAGE_RECEIVED = getAbiItem({ abi: messageTransmitterV2Abi, name: "MessageReceived" });

/** getLogs calls one search may spend; a rate-limited endpoint (HyperEVM) gets one. */
const MAX_CHUNKS = 6;
/** Blocks to measure the chain's real rate over. */
const RATE_SAMPLE = 500;
/** Slack for clocks and block timestamps. */
const MARGIN_MS = 60_000;

export interface MintFinderDeps {
  network: Network;
  /** Head and block reads for an EVM domain. */
  clientFor: (domain: number) => PublicClient;
  logOverrides?: Partial<Record<number, readonly LogEndpoint[]>>;
  solanaRpcUrls: readonly string[];
  now: () => number;
  /** Test seam. */
  clientForUrl?: (url: string) => PublicClient;
}

/**
 * The transaction that used a transfer's nonce on its destination, minted at
 * or after `sinceMs`. For deliveries nobody reported (a self-claim, another
 * relayer). On Solana the nonce's account is touched by its claim only; on an
 * EVM chain MessageReceived indexes the nonce, searched over the blocks since
 * `sinceMs` within a small budget. Null when not found within it.
 */
export function createMintFinder(d: MintFinderDeps) {
  const urlClients = new Map<string, PublicClient>();
  const forUrl =
    d.clientForUrl ??
    ((url: string) => {
      let c = urlClients.get(url);
      if (!c) {
        c = createPublicClient({ transport: http(url, { timeout: 15_000, retryCount: 1 }) });
        urlClients.set(url, c);
      }
      return c;
    });

  async function onSolana(nonce: Hex): Promise<string | null> {
    const sigs = await solanaRpc<{ signature: string; err: unknown }[]>(d.solanaRpcUrls, "getSignaturesForAddress", [
      usedNonceAddress(nonce),
      { limit: 20, commitment: "confirmed" },
    ]);
    // Newest first; the claim created the account, so it is the oldest that succeeded.
    const ok = sigs.filter((s) => s.err === null);
    return ok.at(-1)?.signature ?? null;
  }

  async function onEvm(chain: EvmChain, nonce: Hex, sinceMs: number): Promise<string | null> {
    const client = d.clientFor(chain.domain);
    const head = await client.getBlockNumber();
    const sample = head > BigInt(RATE_SAMPLE) ? BigInt(RATE_SAMPLE) : head;
    const [top, back] = await Promise.all([client.getBlock({ blockNumber: head }), client.getBlock({ blockNumber: head - sample })]);
    const msPerBlock = sample > 0n ? Math.max(1, (Number(top.timestamp - back.timestamp) * 1000) / Number(sample)) : chain.blockTimeMs;
    const span = Math.ceil((d.now() - sinceMs + MARGIN_MS) / msPerBlock);
    const from = head - BigInt(Math.min(span, Number(head)));
    for (const ep of logEndpoints(chain, d.logOverrides?.[chain.domain])) {
      const budget = ep.minIntervalMs ? 1 : MAX_CHUNKS;
      if (Math.ceil(Number(head - from + 1n) / ep.span) > budget) continue;
      try {
        // Newest first: the claim is usually close to now.
        for (let b = head; b >= from; b -= BigInt(ep.span)) {
          const a = b - BigInt(ep.span) + 1n > from ? b - BigInt(ep.span) + 1n : from;
          const logs = await forUrl(ep.url).getLogs({
            address: CCTP_CONTRACTS[d.network].messageTransmitter,
            event: MESSAGE_RECEIVED,
            args: { nonce },
            fromBlock: a,
            toBlock: b,
          });
          if (logs[0]?.transactionHash) return logs[0].transactionHash.toLowerCase();
        }
        return null;
      } catch {
        // The next endpoint gets the whole window.
      }
    }
    return null;
  }

  return async (dstDomain: number, nonce: Hex, sinceMs: number): Promise<string | null> => {
    const chain = chainByDomain(d.network, dstDomain);
    if (!chain) return null;
    return chain.kind === "solana" ? onSolana(nonce) : onEvm(chain, nonce, sinceMs);
  };
}

import {
  type Chain as ViemChain,
  type Hex,
  type PublicClient,
  createPublicClient,
  defineChain,
  fallback,
  http,
} from "viem";
import { messageTransmitterV2Abi } from "./abis.js";
import { type EvmChain, chainByDomain } from "./chains.js";
import { CCTP_CONTRACTS, type Network } from "./constants.js";
import { isSolanaNonceUsed } from "./solana.js";

export function toViemChain(chain: EvmChain, rpcUrls?: readonly string[]): ViemChain {
  const urls = [...(rpcUrls ?? chain.rpcUrls)];
  return defineChain({
    id: chain.chainId,
    name: chain.name,
    nativeCurrency: { name: chain.nativeSymbol, symbol: chain.nativeSymbol, decimals: 18 },
    rpcUrls: { default: { http: urls } },
    blockExplorers: {
      default: { name: "Explorer", url: new URL(chain.explorerTx.replace("{hash}", "")).origin },
    },
  });
}

/**
 * Public client over the chain's ordered RPC list. viem's fallback transport
 * moves to the next URL on transport failures and surfaces deterministic
 * JSON-RPC errors as-is, so a revert is an answer, not a reason to fail over.
 */
export function publicClientFor(chain: EvmChain, rpcUrls?: readonly string[]): PublicClient {
  const urls = rpcUrls ?? chain.rpcUrls;
  return createPublicClient({
    chain: toViemChain(chain, urls),
    transport: fallback(
      urls.map((u) => http(u, { retryCount: 0, timeout: 10_000 })),
      { retryCount: 1 },
    ),
  });
}

export async function isNonceUsed(
  client: PublicClient,
  network: Network,
  nonce: Hex,
): Promise<boolean> {
  const used = await client.readContract({
    address: CCTP_CONTRACTS[network].messageTransmitter,
    abi: messageTransmitterV2Abi,
    functionName: "usedNonces",
    args: [nonce],
  });
  return used !== 0n;
}

/**
 * Per-domain client cache plus the two readers resolveTransfer needs.
 * `rpcOverrides` lets a host app put its own (keyed) endpoints first.
 */
export function createChainReader(
  network: Network,
  rpcOverrides: Partial<Record<number, readonly string[]>> = {},
) {
  const clients = new Map<number, PublicClient>();
  const clientFor = (domain: number): PublicClient => {
    const cached = clients.get(domain);
    if (cached) return cached;
    const chain = chainByDomain(network, domain);
    if (!chain) throw new Error(`Domain ${domain} is not in the ${network} registry`);
    if (chain.kind !== "evm") throw new Error(`${chain.name} is not an EVM chain`);
    const client = publicClientFor(chain, rpcOverrides[domain]);
    clients.set(domain, client);
    return client;
  };
  return {
    clientFor,
    isNonceUsed: (domain: number, nonce: Hex): Promise<boolean> => {
      const chain = chainByDomain(network, domain);
      if (chain?.kind === "solana") {
        return isSolanaNonceUsed(rpcOverrides[domain] ?? chain.rpcUrls, nonce);
      }
      return isNonceUsed(clientFor(domain), network, nonce);
    },
    /** EVM head block. Solana messages carry no expiry we can check this way. */
    destinationBlock: async (domain: number): Promise<bigint> => {
      if (chainByDomain(network, domain)?.kind === "solana") return 0n;
      return clientFor(domain).getBlockNumber();
    },
  };
}

/**
 * EIP-1559 overrides for chains whose RPC reports a zero tip (Injective).
 * Returns undefined elsewhere so the wallet prices the tx itself. Each read
 * fails soft: a transient RPC blip must not drop the floor.
 *
 * `tipFloorWei` replaces the chain's floor. The floor exists for MetaMask
 * (it discards a 0 tip and misprices); a backend signer can pass 0n and pay
 * base fee only, which is how most Injective mints land (0.16 gwei).
 */
export async function feeOverrides(
  client: PublicClient,
  chain: EvmChain,
  tipFloorWei?: bigint,
): Promise<{ maxFeePerGas: bigint; maxPriorityFeePerGas: bigint } | undefined> {
  const floor = tipFloorWei ?? chain.minPriorityFeeWei;
  if (floor === undefined) return undefined;
  const [block, tip] = await Promise.all([
    client.getBlock({ blockTag: "latest" }).catch(() => null),
    client.estimateMaxPriorityFeePerGas().catch(() => 0n),
  ]);
  const baseFee = block?.baseFeePerGas ?? 0n;
  const priority = tip > floor ? tip : floor;
  return { maxFeePerGas: baseFee * 2n + priority, maxPriorityFeePerGas: priority };
}

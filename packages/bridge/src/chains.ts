import type { Address } from "viem";
import type { Network } from "./constants.js";

/**
 * An RPC endpoint the indexer may use for eth_getLogs, with the largest block
 * span proven to return complete results. Several public endpoints silently
 * TRUNCATE an oversized range with HTTP 200 (arb1.arbitrum.io above ~5k blocks,
 * the Injective sentry above ~8k), so a span is only listed once it passed a
 * split-consistency check: whole window == sum of its two halves.
 */
export interface LogRpc {
  url: string;
  span: number;
}

interface ChainBase {
  key: string;
  name: string;
  /** CCTP domain id. */
  domain: number;
  rpcUrls: readonly string[];
  /** Explorer transaction URL with `{hash}` as the placeholder. */
  explorerTx: string;
  /** Circle offers Fast Transfer when burning on this chain. */
  fastSource: boolean;
  /** Circle's Forwarding Service can submit the mint on this chain. */
  forwarding: boolean;
}

export interface EvmChain extends ChainBase {
  kind: "evm";
  chainId: number;
  usdc: Address;
  nativeSymbol: string;
  blockTimeMs: number;
  /** getLogs endpoints with calibrated spans. Empty = not yet calibrated. */
  logRpcs: readonly LogRpc[];
  /**
   * Floor for the EIP-1559 tip. Injective returns 0 from
   * eth_maxPriorityFeePerGas and MetaMask discards a dApp fee suggestion whose
   * tip is 0, then prices the tx against the 150M block gas limit and reports
   * "not enough INJ".
   */
  minPriorityFeeWei?: bigint;
  /** Gas limit for receiveMessage where estimates run short (Polygon ~193k). */
  receiveGasLimit?: bigint;
}

export interface SolanaChain extends ChainBase {
  kind: "solana";
  usdcMint: string;
}

export type Chain = EvmChain | SolanaChain;

export const INJECTIVE_DOMAIN = 29;

const evm = (c: Omit<EvmChain, "kind">): EvmChain => ({ kind: "evm", ...c });

const MAINNET: readonly Chain[] = [
  evm({
    key: "injective",
    name: "Injective",
    domain: INJECTIVE_DOMAIN,
    chainId: 1776,
    usdc: "0xa00C59fF5a080D2b954d0c75e46E22a0c371235a",
    nativeSymbol: "INJ",
    blockTimeMs: 700,
    rpcUrls: [
      "https://sentry.evm-rpc.injective.network",
      "https://injective.rpc.thirdweb.com",
    ],
    logRpcs: [{ url: "https://sentry.evm-rpc.injective.network", span: 5_000 }],
    explorerTx: "https://injscan.com/tx/{hash}",
    fastSource: false,
    forwarding: false,
    minPriorityFeeWei: 1_000_000_000n,
  }),
  evm({
    key: "ethereum",
    name: "Ethereum",
    domain: 0,
    chainId: 1,
    usdc: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
    nativeSymbol: "ETH",
    blockTimeMs: 12_000,
    rpcUrls: [
      "https://ethereum-rpc.publicnode.com",
      "https://eth.drpc.org",
      "https://mainnet.gateway.tenderly.co",
    ],
    logRpcs: [
      { url: "https://mainnet.gateway.tenderly.co", span: 200_000 },
      { url: "https://eth.drpc.org", span: 10_000 },
    ],
    explorerTx: "https://etherscan.io/tx/{hash}",
    fastSource: true,
    forwarding: true,
  }),
  evm({
    key: "base",
    name: "Base",
    domain: 6,
    chainId: 8453,
    usdc: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    nativeSymbol: "ETH",
    blockTimeMs: 2_000,
    rpcUrls: [
      "https://mainnet.base.org",
      "https://base-rpc.publicnode.com",
      "https://base.gateway.tenderly.co",
    ],
    logRpcs: [
      { url: "https://base.gateway.tenderly.co", span: 500_000 },
      { url: "https://mainnet.base.org", span: 2_000 },
    ],
    explorerTx: "https://basescan.org/tx/{hash}",
    fastSource: true,
    forwarding: true,
  }),
  evm({
    key: "arbitrum",
    name: "Arbitrum",
    domain: 3,
    chainId: 42161,
    usdc: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
    nativeSymbol: "ETH",
    blockTimeMs: 250,
    rpcUrls: [
      "https://arb1.arbitrum.io/rpc",
      "https://arbitrum-one-rpc.publicnode.com",
      "https://arbitrum.gateway.tenderly.co",
    ],
    logRpcs: [
      { url: "https://arbitrum.gateway.tenderly.co", span: 2_000_000 },
      { url: "https://arb1.arbitrum.io/rpc", span: 5_000 },
    ],
    explorerTx: "https://arbiscan.io/tx/{hash}",
    fastSource: true,
    forwarding: true,
  }),
  evm({
    key: "optimism",
    name: "OP Mainnet",
    domain: 2,
    chainId: 10,
    usdc: "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85",
    nativeSymbol: "ETH",
    blockTimeMs: 2_000,
    rpcUrls: [
      "https://mainnet.optimism.io",
      "https://optimism-rpc.publicnode.com",
      "https://optimism.gateway.tenderly.co",
    ],
    logRpcs: [
      { url: "https://optimism.gateway.tenderly.co", span: 1_000_000 },
      { url: "https://optimism.drpc.org", span: 5_000 },
    ],
    explorerTx: "https://optimistic.etherscan.io/tx/{hash}",
    fastSource: true,
    forwarding: true,
  }),
  evm({
    key: "polygon",
    name: "Polygon",
    domain: 7,
    chainId: 137,
    usdc: "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359",
    nativeSymbol: "POL",
    blockTimeMs: 2_000,
    rpcUrls: [
      "https://polygon-bor-rpc.publicnode.com",
      "https://polygon.drpc.org",
      "https://polygon.gateway.tenderly.co",
    ],
    logRpcs: [{ url: "https://polygon.gateway.tenderly.co", span: 2_000_000 }],
    explorerTx: "https://polygonscan.com/tx/{hash}",
    fastSource: false,
    forwarding: true,
    receiveGasLimit: 250_000n,
  }),
  evm({
    key: "avalanche",
    name: "Avalanche",
    domain: 1,
    chainId: 43114,
    usdc: "0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E",
    nativeSymbol: "AVAX",
    blockTimeMs: 2_000,
    rpcUrls: [
      "https://api.avax.network/ext/bc/C/rpc",
      "https://avalanche-c-chain-rpc.publicnode.com",
      "https://avalanche.gateway.tenderly.co",
    ],
    logRpcs: [
      { url: "https://avalanche.gateway.tenderly.co", span: 2_000_000 },
      { url: "https://avalanche-c-chain-rpc.publicnode.com", span: 50_000 },
    ],
    explorerTx: "https://snowtrace.io/tx/{hash}",
    fastSource: false,
    forwarding: true,
  }),
  evm({
    key: "linea",
    name: "Linea",
    domain: 11,
    chainId: 59144,
    usdc: "0x176211869cA2b568f2A7D4EE941E073a821EE1ff",
    nativeSymbol: "ETH",
    blockTimeMs: 2_000,
    rpcUrls: ["https://rpc.linea.build", "https://linea.gateway.tenderly.co"],
    logRpcs: [
      { url: "https://linea.gateway.tenderly.co", span: 2_000_000 },
      { url: "https://rpc.linea.build", span: 10_000 },
    ],
    explorerTx: "https://lineascan.build/tx/{hash}",
    fastSource: true,
    forwarding: true,
  }),
  evm({
    key: "unichain",
    name: "Unichain",
    domain: 10,
    chainId: 130,
    usdc: "0x078D782b760474a361dDA0AF3839290b0EF57AD6",
    nativeSymbol: "ETH",
    blockTimeMs: 1_000,
    rpcUrls: ["https://mainnet.unichain.org"],
    logRpcs: [],
    explorerTx: "https://uniscan.xyz/tx/{hash}",
    fastSource: true,
    forwarding: true,
  }),
  evm({
    key: "sonic",
    name: "Sonic",
    domain: 13,
    chainId: 146,
    usdc: "0x29219dd400f2Bf60E5a23d13Be72B486D4038894",
    nativeSymbol: "S",
    blockTimeMs: 1_000,
    rpcUrls: ["https://rpc.soniclabs.com", "https://sonic.drpc.org"],
    logRpcs: [],
    explorerTx: "https://sonicscan.org/tx/{hash}",
    fastSource: false,
    forwarding: true,
  }),
  evm({
    key: "worldchain",
    name: "World Chain",
    domain: 14,
    chainId: 480,
    // Circle's docs and the v1 config print this with an invalid EIP-55
    // checksum; viem refuses that form.
    usdc: "0x79A02482A880bCE3F13e09Da970dC34db4CD24d1",
    nativeSymbol: "ETH",
    blockTimeMs: 2_000,
    rpcUrls: ["https://worldchain-mainnet.g.alchemy.com/public"],
    logRpcs: [],
    explorerTx: "https://worldscan.org/tx/{hash}",
    fastSource: true,
    forwarding: true,
  }),
  evm({
    key: "hyperevm",
    name: "HyperEVM",
    domain: 19,
    chainId: 999,
    usdc: "0xb88339CB7199b77E23DB6E890353E22632Ba630f",
    nativeSymbol: "HYPE",
    blockTimeMs: 1_000,
    rpcUrls: ["https://rpc.hyperliquid.xyz/evm"],
    logRpcs: [],
    explorerTx: "https://hyperevmscan.io/tx/{hash}",
    fastSource: false,
    forwarding: true,
  }),
  evm({
    key: "monad",
    name: "Monad",
    domain: 15,
    chainId: 143,
    usdc: "0x754704Bc059F8C67012fEd69BC8A327a5aafb603",
    nativeSymbol: "MON",
    blockTimeMs: 400,
    rpcUrls: ["https://rpc.monad.xyz"],
    logRpcs: [],
    explorerTx: "https://monadscan.com/tx/{hash}",
    fastSource: false,
    forwarding: true,
  }),
  evm({
    key: "sei",
    name: "Sei",
    domain: 16,
    chainId: 1329,
    usdc: "0xe15fC38F6D8c56aF07bbCBe3BAf5708A2Bf42392",
    nativeSymbol: "SEI",
    blockTimeMs: 400,
    rpcUrls: ["https://evm-rpc.sei-apis.com"],
    logRpcs: [],
    explorerTx: "https://seiscan.io/tx/{hash}",
    fastSource: false,
    forwarding: true,
  }),
  evm({
    key: "plasma",
    name: "Plasma",
    domain: 33,
    chainId: 9745,
    usdc: "0x2d661C89D812261039AF9764eceaAee884f5F67F",
    nativeSymbol: "XPL",
    blockTimeMs: 1_000,
    rpcUrls: ["https://rpc.plasma.to"],
    logRpcs: [],
    explorerTx: "https://plasmascan.to/tx/{hash}",
    fastSource: false,
    forwarding: false,
  }),
  evm({
    key: "ink",
    name: "Ink",
    domain: 21,
    chainId: 57073,
    usdc: "0x2D270e6886d130D724215A266106e6832161EAEd",
    nativeSymbol: "ETH",
    blockTimeMs: 1_000,
    rpcUrls: ["https://rpc-gel.inkonchain.com"],
    logRpcs: [],
    explorerTx: "https://explorer.inkonchain.com/tx/{hash}",
    fastSource: true,
    forwarding: true,
  }),
  {
    kind: "solana",
    key: "solana",
    name: "Solana",
    domain: 5,
    usdcMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    rpcUrls: ["https://solana-rpc.publicnode.com"],
    explorerTx: "https://solscan.io/tx/{hash}",
    fastSource: true,
    forwarding: true,
  },
];

const TESTNET: readonly Chain[] = [
  evm({
    key: "injective",
    name: "Injective Testnet",
    domain: INJECTIVE_DOMAIN,
    chainId: 1439,
    usdc: "0x0C382e685bbeeFE5d3d9C29e29E341fEE8E84C5d",
    nativeSymbol: "INJ",
    blockTimeMs: 700,
    rpcUrls: ["https://k8s.testnet.json-rpc.injective.network"],
    logRpcs: [],
    explorerTx: "https://testnet.blockscout.injective.network/tx/{hash}",
    fastSource: false,
    forwarding: false,
    minPriorityFeeWei: 1_000_000_000n,
  }),
  evm({
    key: "ethereum",
    name: "Sepolia",
    domain: 0,
    chainId: 11155111,
    usdc: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238",
    nativeSymbol: "ETH",
    blockTimeMs: 12_000,
    rpcUrls: ["https://ethereum-sepolia-rpc.publicnode.com"],
    logRpcs: [],
    explorerTx: "https://sepolia.etherscan.io/tx/{hash}",
    fastSource: true,
    forwarding: true,
  }),
  evm({
    key: "base",
    name: "Base Sepolia",
    domain: 6,
    chainId: 84532,
    usdc: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
    nativeSymbol: "ETH",
    blockTimeMs: 2_000,
    rpcUrls: ["https://sepolia.base.org"],
    logRpcs: [],
    explorerTx: "https://sepolia.basescan.org/tx/{hash}",
    fastSource: true,
    forwarding: true,
  }),
  evm({
    key: "arbitrum",
    name: "Arbitrum Sepolia",
    domain: 3,
    chainId: 421614,
    usdc: "0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d",
    nativeSymbol: "ETH",
    blockTimeMs: 250,
    rpcUrls: ["https://sepolia-rollup.arbitrum.io/rpc"],
    logRpcs: [],
    explorerTx: "https://sepolia.arbiscan.io/tx/{hash}",
    fastSource: true,
    forwarding: true,
  }),
];

const REGISTRY: Record<Network, readonly Chain[]> = {
  mainnet: MAINNET,
  testnet: TESTNET,
};

export function chains(network: Network): readonly Chain[] {
  return REGISTRY[network];
}

export function injective(network: Network): EvmChain {
  const c = chainByDomain(network, INJECTIVE_DOMAIN);
  if (!c || c.kind !== "evm") throw new Error(`Injective missing from ${network} registry`);
  return c;
}

/** Every chain that can bridge with Injective, i.e. everything but Injective. */
export function peers(network: Network): readonly Chain[] {
  return REGISTRY[network].filter((c) => c.domain !== INJECTIVE_DOMAIN);
}

export function chainByDomain(network: Network, domain: number): Chain | undefined {
  return REGISTRY[network].find((c) => c.domain === domain);
}

export function chainByKey(network: Network, key: string): Chain | undefined {
  return REGISTRY[network].find((c) => c.key === key);
}

export function explorerTxUrl(chain: Chain, hash: string): string {
  return chain.explorerTx.replace("{hash}", hash);
}

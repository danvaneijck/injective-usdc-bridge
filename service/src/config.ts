import { type Address, getAddress, isAddress, parseEther, parseUnits } from "viem";
import { BRIDGE_RECEIVER, type Network, chains } from "injective-usdc-bridge";

export type Mode = "shadow" | "relay";

export interface ServiceConfig {
  network: Network;
  /** shadow: index and track only, never send. relay: also mint deposits. */
  mode: Mode;
  dbPath: string;
  port: number;
  /** File holding the relayer's hex private key. Never logged. */
  relayerKeyFile?: string;
  /** BridgeReceiver (gas-drop deposits); defaults to the deployed one. */
  bridgeReceiver?: Address;
  /** v1 GasDropReceivers whose pinned burns we also complete. */
  legacyReceivers: Address[];
  /** Registry keys of the EVM chains to index. */
  chainKeys: string[];
  /** How far back to start a chain that has no cursor yet. */
  startLookbackSec: number;
  /** Wait after attestation before we mint a plain deposit (lets a user's own mint land). */
  depositGraceSec: number;
  /** Wait before relaying a burn pinned to a v1 receiver (v1's backend relays those). */
  legacyGraceSec: number;
  /** Relayer INJ balance below which /health reports low; under the keeper's refill mark. */
  relayerLowInj: number;
  irisRps: number;
  /** Per-domain RPC lists placed ahead of the registry's, for reads and sends. */
  rpcOverrides: Record<number, string[]>;
  /**
   * Per-domain eth_getLogs endpoints with their spans, ahead of the registry's.
   * Separate from rpcOverrides on purpose: a pruning node (the Choice box's
   * local Injective node) answers old getLogs ranges with an EMPTY result, not
   * an error, which would silently drop burns during a backfill.
   */
  logRpcOverrides: Record<number, { url: string; span: number }[]>;
  keeper: KeeperSettings;
}

/** The refill keeper (relay mode on mainnet): see keeper.ts. */
export interface KeeperSettings {
  enabled: boolean;
  floatLowWei: bigint;
  floatTargetWei: bigint;
  relayerLowWei: bigint;
  relayerTargetWei: bigint;
  minSwapUsdc: bigint;
  maxSwapUsdc: bigint;
  slippageBps: number;
  /** Choice v2's api, whose /route builds the aggregator swap. */
  routeApi: string;
}

function keeperSettings(env: NodeJS.ProcessEnv): KeeperSettings {
  const inj = (name: string, def: string) => parseEther(env[name] ?? def);
  const usdc = (name: string, def: string) => parseUnits(env[name] ?? def, 6);
  const k: KeeperSettings = {
    enabled: (env.KEEPER ?? "on") !== "off",
    // A drop is 0.02 INJ: refill under two drops, back up to three.
    floatLowWei: inj("KEEPER_FLOAT_LOW_INJ", "0.04"),
    floatTargetWei: inj("KEEPER_FLOAT_TARGET_INJ", "0.06"),
    // A mint is ~0.0001 INJ: 0.03 is ~300 of them.
    relayerLowWei: inj("KEEPER_RELAYER_LOW_INJ", "0.03"),
    relayerTargetWei: inj("KEEPER_RELAYER_TARGET_INJ", "0.05"),
    // One drop's fee; Helix legs need $1, so smaller swaps route through pools.
    minSwapUsdc: usdc("KEEPER_MIN_SWAP_USDC", "0.5"),
    maxSwapUsdc: usdc("KEEPER_MAX_SWAP_USDC", "5"),
    slippageBps: Number(env.KEEPER_SLIPPAGE_BPS ?? 100),
    routeApi: env.CHOICE_ROUTE_API ?? "https://evm-api.choice.exchange",
  };
  if (k.floatLowWei > k.floatTargetWei || k.relayerLowWei > k.relayerTargetWei) {
    throw new Error("KEEPER_*_LOW_INJ must not exceed its KEEPER_*_TARGET_INJ");
  }
  if (k.minSwapUsdc > k.maxSwapUsdc) throw new Error("KEEPER_MIN_SWAP_USDC exceeds KEEPER_MAX_SWAP_USDC");
  return k;
}

/** Mainnet v1 GasDropReceiver v4 (live) and v3 (older burns may be pinned to it). */
const MAINNET_LEGACY_RECEIVERS: Address[] = [
  "0xbe7ad6bd72585fe0d38ffb16db0e00f085a754b4",
  "0xced8c8f6cc011d22afced60177a57862a4837ec3",
].map((a) => getAddress(a));

function addressOrUndefined(v: string | undefined, name: string): Address | undefined {
  if (!v) return undefined;
  if (!isAddress(v, { strict: false })) throw new Error(`${name} is not an address: ${v}`);
  return getAddress(v);
}

/** Choice v2's stack names networks injective_mainnet / injective_testnet. */
const NETWORK_ALIASES: Record<string, Network> = {
  mainnet: "mainnet",
  testnet: "testnet",
  injective_mainnet: "mainnet",
  injective_testnet: "testnet",
};
const CHAIN_IDS: Record<Network, string> = { mainnet: "1776", testnet: "1439" };

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServiceConfig {
  const network = NETWORK_ALIASES[env.NETWORK ?? "mainnet"];
  if (!network) throw new Error(`Bad NETWORK ${env.NETWORK}`);
  // Choice v2's preflight requires CHAIN_ID on every service; make it agree.
  if (env.CHAIN_ID && env.CHAIN_ID !== CHAIN_IDS[network]) {
    throw new Error(`CHAIN_ID ${env.CHAIN_ID} does not match NETWORK ${env.NETWORK}`);
  }
  const mode = (env.MODE ?? "shadow") as Mode;
  if (mode !== "shadow" && mode !== "relay") throw new Error(`Bad MODE ${mode}`);

  const evmKeys = chains(network)
    .filter((c) => c.kind === "evm")
    .map((c) => c.key);
  const chainKeys = env.CHAINS ? env.CHAINS.split(",").map((s) => s.trim()) : evmKeys;
  for (const k of chainKeys) {
    if (!evmKeys.includes(k)) throw new Error(`CHAINS has unknown EVM chain ${k}`);
  }

  // RPC_<DOMAIN>=url1,url2  e.g. RPC_29=http://172.30.0.1:8545
  // LOG_RPC_<DOMAIN>=url@span,url@span  e.g. LOG_RPC_19=https://keyed-hyperevm@1000
  const rpcOverrides: Record<number, string[]> = {};
  const logRpcOverrides: Record<number, { url: string; span: number }[]> = {};
  for (const [k, v] of Object.entries(env)) {
    if (!v) continue;
    const rpc = /^RPC_(\d+)$/.exec(k);
    if (rpc) rpcOverrides[Number(rpc[1])] = v.split(",").map((s) => s.trim());
    const logs = /^LOG_RPC_(\d+)$/.exec(k);
    if (logs) {
      logRpcOverrides[Number(logs[1])] = v.split(",").map((entry) => {
        const at = entry.lastIndexOf("@");
        const span = at > 0 ? Number(entry.slice(at + 1)) : NaN;
        if (!Number.isInteger(span) || span <= 0) throw new Error(`${k}: "${entry}" must be url@span`);
        return { url: entry.slice(0, at).trim(), span };
      });
    }
  }

  const legacy = env.LEGACY_RECEIVERS
    ? env.LEGACY_RECEIVERS.split(",").map((s) => addressOrUndefined(s.trim(), "LEGACY_RECEIVERS")!)
    : network === "mainnet"
      ? MAINNET_LEGACY_RECEIVERS
      : [];

  const config: ServiceConfig = {
    network,
    mode,
    dbPath: env.DB_PATH ?? "./data/bridge.sqlite",
    port: Number(env.PORT ?? 8787),
    relayerKeyFile: env.RELAYER_KEY_FILE || undefined,
    bridgeReceiver: addressOrUndefined(env.BRIDGE_RECEIVER, "BRIDGE_RECEIVER") ?? BRIDGE_RECEIVER[network],
    legacyReceivers: legacy,
    chainKeys,
    startLookbackSec: Number(env.START_LOOKBACK_SEC ?? 6 * 3600),
    depositGraceSec: Number(env.DEPOSIT_GRACE_SEC ?? 15),
    legacyGraceSec: Number(env.LEGACY_GRACE_SEC ?? 120),
    relayerLowInj: Number(env.RELAYER_LOW_INJ ?? 0.02),
    irisRps: Number(env.IRIS_RPS ?? 5),
    rpcOverrides,
    logRpcOverrides,
    keeper: keeperSettings(env),
  };
  if (config.mode === "relay" && !config.relayerKeyFile) {
    throw new Error("MODE=relay needs RELAYER_KEY_FILE");
  }
  return config;
}

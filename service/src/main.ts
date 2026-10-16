import { readFileSync } from "node:fs";
import { serve } from "@hono/node-server";
import { type Hex, createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  IrisClient,
  chainByDomain,
  chainByKey,
  createChainReader,
  injective,
  publicClientFor,
  toViemChain,
  type EvmChain,
} from "injective-usdc-bridge";
import { createApi } from "./api.js";
import { loadConfig } from "./config.js";
import { Store } from "./db.js";
import { Health } from "./health.js";
import { ChainIndexer, ingestTx } from "./indexer.js";
import { createLogger } from "./log.js";
import { Relayer } from "./relayer.js";
import { RateLimiter } from "./timing.js";
import { Tracker } from "./tracker.js";

const config = loadConfig();
const log = createLogger((process.env.LOG_LEVEL as "info") ?? "info", { svc: "bridge" });
const now = () => Date.now();
const store = new Store(config.dbPath);
const iris = new IrisClient({ network: config.network, userAgent: "injective-usdc-bridge-service/0.0" });
const irisLimiter = new RateLimiter(config.irisRps);
const reader = createChainReader(config.network, config.rpcOverrides);
const inj = injective(config.network);
const injClient = publicClientFor(inj, [...(config.rpcOverrides[inj.domain] ?? []), ...inj.rpcUrls]);
const ctx = { bridgeReceiver: config.bridgeReceiver, legacyReceivers: config.legacyReceivers };

let wallet: ConstructorParameters<typeof Relayer>[0]["wallet"];
if (config.relayerKeyFile) {
  const raw = readFileSync(config.relayerKeyFile, "utf8").trim();
  const account = privateKeyToAccount((raw.startsWith("0x") ? raw : `0x${raw}`) as Hex);
  wallet = createWalletClient({
    account,
    chain: toViemChain(inj),
    transport: http(config.rpcOverrides[inj.domain]?.[0] ?? inj.rpcUrls[0]),
  });
}

const indexers = config.chainKeys.map((key) => {
  const chain = chainByKey(config.network, key) as EvmChain;
  return new ChainIndexer({
    chain,
    network: config.network,
    store,
    ctx,
    log,
    now,
    startLookbackSec: config.startLookbackSec,
    rpcOverrides: config.rpcOverrides[chain.domain],
    logOverrides: config.logRpcOverrides[chain.domain],
  });
});

const tracker = new Tracker({
  store,
  iris,
  irisLimiter,
  network: config.network,
  isNonceUsed: reader.isNonceUsed,
  destinationBlock: reader.destinationBlock,
  txTime: async (domain, hash) => {
    if (chainByDomain(config.network, domain)?.kind !== "evm") return null;
    const client = reader.clientFor(domain);
    const receipt = await client.getTransactionReceipt({ hash });
    const block = await client.getBlock({ blockNumber: receipt.blockNumber });
    return Number(block.timestamp) * 1000;
  },
  log,
  now,
});

const relayer = new Relayer({
  store,
  network: config.network,
  mode: config.mode,
  injective: inj,
  client: injClient,
  wallet,
  bridgeReceiver: config.bridgeReceiver,
  depositGraceSec: config.depositGraceSec,
  legacyGraceSec: config.legacyGraceSec,
  isNonceUsed: reader.isNonceUsed,
  log,
  now,
});

const health = new Health({
  store,
  network: config.network,
  mode: config.mode,
  chainKeys: config.chainKeys,
  now,
  relayer: wallet ? { address: wallet.account.address, client: injClient, lowInj: config.relayerLowInj } : undefined,
});

const api = createApi({
  store,
  network: config.network,
  health,
  bridgeReceiver: config.bridgeReceiver,
  ingest: async (domain, txHash) => {
    const chain = chainByDomain(config.network, domain) as EvmChain;
    await ingestTx({ chain, network: config.network, client: reader.clientFor(domain), store, ctx, txHash, now: now() });
    await tracker.checkTx(domain, txHash);
  },
});

let running = true;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Run `fn` back to back with `idleMs` between rounds and a longer pause after errors. */
async function loop(name: string, fn: () => Promise<boolean>, idleMs: number): Promise<void> {
  let failures = 0;
  while (running) {
    try {
      const busy = await fn();
      failures = 0;
      await sleep(busy ? 200 : idleMs);
    } catch (e) {
      failures++;
      log.warn("loop error", { loop: name, failures, error: (e as Error).message.split("\n")[0] });
      await sleep(Math.min(5_000 * 2 ** Math.min(failures, 5), 120_000));
    }
  }
}

log.info("starting", {
  network: config.network,
  mode: config.mode,
  chains: config.chainKeys,
  relayer: wallet?.account.address ?? null,
  bridgeReceiver: config.bridgeReceiver ?? null,
  legacyReceivers: config.legacyReceivers,
});

const loops = [
  // A partial window means the endpoint pushed back: wait the idle pause
  // before the next one instead of going straight back.
  ...indexers.map((ix) =>
    loop(
      `index:${ix.chain.key}`,
      async () => {
        const r = await ix.tick();
        return r !== null && !r.partial;
      },
      ix.idleMs,
    ),
  ),
  loop("track", async () => (await tracker.tick()) > 0, 1_000),
  loop("relay", async () => (await relayer.tick()) > 0, 3_000),
  loop("health", async () => (await health.refreshRelayerBalance(), false), 60_000),
];

const server = serve({ fetch: api.fetch, port: config.port }, (info) => log.info("api listening", { port: info.port }));

async function shutdown(signal: string) {
  log.info("shutting down", { signal });
  running = false;
  server.close();
  await Promise.race([Promise.allSettled(loops), sleep(5_000)]);
  store.close();
  process.exit(0);
}
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

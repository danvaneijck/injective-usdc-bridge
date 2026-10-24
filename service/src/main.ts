import { readFileSync } from "node:fs";
import { serve } from "@hono/node-server";
import { type Hex, createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  IrisClient,
  bytes32ToSolana,
  chainByDomain,
  chainByKey,
  createChainReader,
  injective,
  parseTokenAccount,
  publicClientFor,
  solanaAccount,
  solanaRpc,
  toViemChain,
  type EvmChain,
  type SolanaChain,
} from "injective-usdc-bridge";
import { createApi } from "./api.js";
import { loadConfig } from "./config.js";
import { Store } from "./db.js";
import { Health } from "./health.js";
import { ChainIndexer, ingestTx } from "./indexer.js";
import { CHOICE_MAINNET, Keeper, routeApi } from "./keeper.js";
import { createLogger } from "./log.js";
import { createMintFinder } from "./mintFinder.js";
import { Relayer } from "./relayer.js";
import { SolanaIndexer } from "./solanaIndexer.js";
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

const evmKeys = config.chainKeys.filter((key) => chainByKey(config.network, key)?.kind === "evm");
const indexers = evmKeys.map((key) => {
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

const solanaChain = config.chainKeys.includes("solana") ? (chainByKey(config.network, "solana") as SolanaChain) : undefined;
const solanaRpcUrls = solanaChain ? [...(config.rpcOverrides[solanaChain.domain] ?? []), ...solanaChain.rpcUrls] : [];
const solanaIndexer = solanaChain
  ? new SolanaIndexer({
      chain: solanaChain,
      store,
      ctx,
      log,
      now,
      startLookbackSec: config.startLookbackSec,
      rpcUrls: solanaRpcUrls,
      iris,
    })
  : undefined;

const tracker = new Tracker({
  store,
  iris,
  irisLimiter,
  network: config.network,
  isNonceUsed: reader.isNonceUsed,
  destinationBlock: reader.destinationBlock,
  txTime: async (domain, hash) => {
    const chain = chainByDomain(config.network, domain);
    if (chain?.kind === "solana") {
      const tx = await solanaRpc<{ blockTime: number | null } | null>(solanaRpcUrls, "getTransaction", [
        hash,
        { encoding: "json", maxSupportedTransactionVersion: 1 },
      ]);
      return tx?.blockTime ? tx.blockTime * 1000 : null;
    }
    if (chain?.kind !== "evm") return null;
    const client = reader.clientFor(domain);
    const receipt = await client.getTransactionReceipt({ hash: hash as Hex });
    const block = await client.getBlock({ blockNumber: receipt.blockNumber });
    return Number(block.timestamp) * 1000;
  },
  solanaOwner: async (tokenAccount) => {
    if (!solanaChain) return null;
    const account = await solanaAccount(solanaRpcUrls, bytes32ToSolana(tokenAccount));
    return account ? (parseTokenAccount(account)?.owner ?? null) : null;
  },
  findMintTx: createMintFinder({
    network: config.network,
    clientFor: reader.clientFor,
    logOverrides: config.logRpcOverrides,
    solanaRpcUrls,
    now,
  }),
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
  minRelayPlain: config.minRelayPlain,
  isNonceUsed: reader.isNonceUsed,
  log,
  now,
});

// The refill keeper signs with the relayer's key, so it runs only where the
// relayer sends, and only on mainnet, where Choice's aggregator is.
const k = config.keeper;
const keeper =
  config.mode === "relay" && wallet && config.bridgeReceiver && config.network === "mainnet" && k.enabled
    ? new Keeper({
        cfg: {
          receiver: config.bridgeReceiver,
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
        },
        injective: inj,
        client: injClient,
        wallet,
        aggregator: CHOICE_MAINNET.aggregator,
        permit2: CHOICE_MAINNET.permit2,
        fetchRoute: routeApi(k.routeApi),
        log,
        now,
      })
    : undefined;

const health = new Health({
  store,
  network: config.network,
  mode: config.mode,
  chainKeys: config.chainKeys,
  now,
  relayer: wallet ? { address: wallet.account.address, client: injClient, lowInj: config.relayerLowInj } : undefined,
  keeper: keeper ? () => keeper.status() : undefined,
});

const api = createApi({
  store,
  network: config.network,
  health,
  log,
  bridgeReceiver: config.bridgeReceiver,
  ingest: async (domain, txHash) => {
    const chain = chainByDomain(config.network, domain);
    if (chain?.kind === "solana") {
      if (!solanaIndexer) return;
      await solanaIndexer.ingest(txHash);
    } else if (chain?.kind === "evm") {
      await ingestTx({ chain, network: config.network, client: reader.clientFor(domain), store, ctx, txHash: txHash as Hex, now: now() });
    }
    await tracker.checkTx(domain, txHash);
  },
  ingestAnywhere: async (txHash) => {
    if (!txHash.startsWith("0x")) {
      if (!solanaIndexer || !solanaChain) return;
      await solanaIndexer.ingest(txHash);
      await tracker.checkTx(solanaChain.domain, txHash);
      return;
    }
    // A hash is unique across chains in practice: ask every EVM chain at once.
    const found = await Promise.all(
      evmKeys.map(async (key) => {
        const chain = chainByKey(config.network, key) as EvmChain;
        const client = reader.clientFor(chain.domain);
        const rows = await ingestTx({ chain, network: config.network, client, store, ctx, txHash: txHash as Hex, now: now() }).catch(() => []);
        return rows.length > 0 ? chain.domain : null;
      }),
    );
    for (const domain of found) if (domain !== null) await tracker.checkTx(domain, txHash);
  },
  siteDir: config.siteDir,
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
  keeper: keeper !== undefined,
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
  ...(solanaIndexer ? [loop("index:solana", async () => (await solanaIndexer.tick()) !== null, solanaIndexer.idleMs)] : []),
  loop("track", async () => (await tracker.tick()) > 0, 1_000),
  loop("relay", async () => (await relayer.tick()) > 0, 3_000),
  loop("health", async () => (await health.refreshRelayerBalance(), false), 60_000),
  ...(keeper ? [loop("keeper", async () => (await keeper.tick(), false), 3 * 60_000)] : []),
];

if (solanaChain) {
  // Best effort, off the startup path: wallets for transfers to Solana that finished without one.
  void tracker.fillMissingSolanaRecipients(solanaChain.domain).then(
    (filled) => filled > 0 && log.info("solana recipients filled", { filled }),
    (e: unknown) => log.warn("solana recipient fill failed", { error: (e as Error).message }),
  );
}

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

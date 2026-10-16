import {
  type Hex,
  type Log,
  type PublicClient,
  createPublicClient,
  decodeEventLog,
  getAbiItem,
  http,
  toEventSelector,
} from "viem";
import {
  CCTP_CONTRACTS,
  type EvmChain,
  INJECTIVE_DOMAIN,
  type Network,
  publicClientFor,
  tokenMessengerV2Abi,
} from "injective-usdc-bridge";
import { type ClassifyContext, type DepositForBurnArgs, isRelevant, toNewTransfer } from "./classify.js";
import type { NewTransfer, Store } from "./db.js";
import type { Logger } from "./log.js";

const DEPOSIT_FOR_BURN = getAbiItem({ abi: tokenMessengerV2Abi, name: "DepositForBurn" });
const DEPOSIT_FOR_BURN_TOPIC = toEventSelector(DEPOSIT_FOR_BURN);

/** Span for endpoints nobody has calibrated. Small on purpose: see LogRpc. */
export const DEFAULT_SPAN = 1_000;

export interface LogEndpoint {
  url: string;
  span: number;
  minIntervalMs?: number;
}

/** Blocks to stay behind head. Iris waits for finality anyway; this only avoids indexing orphans. */
export function confirmationsFor(chain: EvmChain): number {
  if (chain.domain === INJECTIVE_DOMAIN) return 0;
  if (chain.key === "polygon") return 16;
  if (chain.key === "ethereum") return 2;
  return 4;
}

export function logEndpoints(chain: EvmChain, overrides: readonly string[] = []): LogEndpoint[] {
  const out: LogEndpoint[] = overrides.map((url) => ({ url, span: DEFAULT_SPAN }));
  for (const e of chain.logRpcs) out.push({ url: e.url, span: e.span, minIntervalMs: e.minIntervalMs });
  for (const url of chain.rpcUrls) {
    if (!out.some((e) => e.url === url)) out.push({ url, span: DEFAULT_SPAN });
  }
  return out;
}

export interface IndexerOptions {
  chain: EvmChain;
  network: Network;
  store: Store;
  ctx: ClassifyContext;
  log: Logger;
  now: () => number;
  startLookbackSec: number;
  rpcOverrides?: readonly string[];
  /** Max blocks covered per tick, as a multiple of the primary endpoint's span. */
  maxSpansPerTick?: number;
  /** Test seam. */
  clientForUrl?: (url: string) => PublicClient;
  headClient?: PublicClient;
}

export class ChainIndexer {
  readonly chain: EvmChain;
  private readonly endpoints: LogEndpoint[];
  private readonly head: PublicClient;
  private readonly clientForUrl: (url: string) => PublicClient;
  private readonly clients = new Map<string, PublicClient>();
  lastHead = 0;

  constructor(private readonly o: IndexerOptions) {
    this.chain = o.chain;
    this.endpoints = logEndpoints(o.chain, o.rpcOverrides);
    this.head = o.headClient ?? publicClientFor(o.chain, [...(o.rpcOverrides ?? []), ...o.chain.rpcUrls]);
    this.clientForUrl =
      o.clientForUrl ?? ((url) => createPublicClient({ transport: http(url, { timeout: 20_000, retryCount: 1 }) }));
  }

  /** Scan the next window. Returns null when already at the target block. */
  async tick(): Promise<{ from: number; to: number; added: number; endpoint: string } | null> {
    const head = Number(await this.head.getBlockNumber());
    this.lastHead = head;
    const target = head - confirmationsFor(this.chain);
    let cursor = this.o.store.getCursor(this.chain.key);
    if (cursor === undefined) cursor = await this.initCursor(head, target);
    if (cursor >= target) {
      this.o.store.setCursor(this.chain.key, cursor, head, this.o.now());
      return null;
    }
    const primarySpan = this.endpoints[0]?.span ?? DEFAULT_SPAN;
    const from = cursor + 1;
    const to = Math.min(target, cursor + primarySpan * (this.o.maxSpansPerTick ?? 20));

    const { logs, endpoint } = await this.fetchWindow(from, to);
    const rows = await this.toRows(logs);
    const added = this.o.store.insertTransfers(rows, this.o.now());
    this.o.store.setCursor(this.chain.key, to, head, this.o.now());
    if (added > 0) this.o.log.info("burns indexed", { chain: this.chain.key, from, to, added });
    return { from, to, added, endpoint };
  }

  /**
   * Pick the first block from the chain's measured block rate, not the
   * registry's estimate (Avalanche's real rate was twice the registry's, which
   * silently halved the lookback). Records the start block's real timestamp
   * as where this chain's coverage begins.
   */
  private async initCursor(head: number, target: number): Promise<number> {
    const sample = Math.min(2_000, head);
    const [now, then] = await Promise.all([
      this.head.getBlock({ blockNumber: BigInt(head) }),
      this.head.getBlock({ blockNumber: BigInt(head - sample) }),
    ]);
    const msPerBlock = sample > 0 ? (Number(now.timestamp - then.timestamp) * 1000) / sample : this.chain.blockTimeMs;
    const lookback = Math.ceil((this.o.startLookbackSec * 1000) / Math.max(msPerBlock, 1));
    const start = Math.max(1, target - lookback);
    const startBlock = await this.head.getBlock({ blockNumber: BigInt(start) });
    this.o.store.setCursorStart(this.chain.key, start, Number(startBlock.timestamp), this.o.now());
    this.o.log.info("cursor initialised", {
      chain: this.chain.key,
      startBlock: start,
      startTime: new Date(Number(startBlock.timestamp) * 1000).toISOString(),
      msPerBlock: Math.round(msPerBlock),
    });
    return start - 1;
  }

  /**
   * Fetch [from, to] entirely from one endpoint, chunked by that endpoint's
   * proven span. A failure anywhere drops the partial result and retries the
   * whole window on the next endpoint, so results are never stitched from
   * endpoints with different truncation behaviour.
   */
  private async fetchWindow(from: number, to: number): Promise<{ logs: Log[]; endpoint: string }> {
    let lastError: unknown;
    for (const ep of this.endpoints) {
      try {
        const client = this.client(ep.url);
        const logs: Log[] = [];
        for (let a = from; a <= to; a += ep.span) {
          if (ep.minIntervalMs && a > from) await new Promise((r) => setTimeout(r, ep.minIntervalMs));
          const b = Math.min(to, a + ep.span - 1);
          const chunk = await client.getLogs({
            address: CCTP_CONTRACTS[this.o.network].tokenMessenger,
            event: DEPOSIT_FOR_BURN,
            fromBlock: BigInt(a),
            toBlock: BigInt(b),
          });
          logs.push(...(chunk as Log[]));
        }
        return { logs, endpoint: ep.url };
      } catch (e) {
        lastError = e;
        this.o.log.warn("getLogs endpoint failed", {
          chain: this.chain.key,
          url: ep.url,
          from,
          to,
          error: (e as Error).message.split("\n")[0],
        });
      }
    }
    throw lastError ?? new Error(`No log endpoints for ${this.chain.key}`);
  }

  private client(url: string): PublicClient {
    let c = this.clients.get(url);
    if (!c) {
      c = this.clientForUrl(url);
      this.clients.set(url, c);
    }
    return c;
  }

  private async toRows(logs: Log[]): Promise<NewTransfer[]> {
    const relevant: { args: DepositForBurnArgs; log: Log }[] = [];
    for (const log of logs) {
      const args = decodeDepositForBurn(log);
      if (args && isRelevant(this.chain.domain, args)) relevant.push({ args, log });
    }
    const times = new Map<bigint, number | null>();
    for (const { log } of relevant) {
      const bn = log.blockNumber!;
      if (!times.has(bn)) {
        const block = await this.head.getBlock({ blockNumber: bn }).catch(() => null);
        times.set(bn, block ? Number(block.timestamp) : null);
      }
    }
    return relevant.map(({ args, log }) =>
      toNewTransfer(
        args,
        {
          srcDomain: this.chain.domain,
          txHash: log.transactionHash as Hex,
          logIndex: log.logIndex!,
          blockNumber: log.blockNumber!,
          blockTime: times.get(log.blockNumber!) ?? null,
        },
        this.o.ctx,
      ),
    );
  }
}

export function decodeDepositForBurn(log: Pick<Log, "data" | "topics">): DepositForBurnArgs | null {
  if (log.topics[0]?.toLowerCase() !== DEPOSIT_FOR_BURN_TOPIC) return null;
  try {
    const { args } = decodeEventLog({ abi: tokenMessengerV2Abi, data: log.data, topics: log.topics as never });
    return args as unknown as DepositForBurnArgs;
  } catch {
    return null;
  }
}

/**
 * Index one transaction right away (the widget's hint after a burn), so
 * tracking does not wait for the chain loop. Returns the rows it touched.
 */
export async function ingestTx(opts: {
  chain: EvmChain;
  network: Network;
  client: PublicClient;
  store: Store;
  ctx: ClassifyContext;
  txHash: Hex;
  now: number;
}): Promise<NewTransfer[]> {
  let receipt: Awaited<ReturnType<PublicClient["getTransactionReceipt"]>>;
  try {
    receipt = await opts.client.getTransactionReceipt({ hash: opts.txHash });
  } catch (e) {
    // Not mined yet (the widget hints right after signing) or no such tx.
    if ((e as Error).name === "TransactionReceiptNotFoundError") return [];
    throw e;
  }
  if (receipt.status !== "success") return [];
  const tm = CCTP_CONTRACTS[opts.network].tokenMessenger.toLowerCase();
  const block = await opts.client.getBlock({ blockNumber: receipt.blockNumber }).catch(() => null);
  const rows: NewTransfer[] = [];
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== tm) continue;
    const args = decodeDepositForBurn(log);
    if (!args || !isRelevant(opts.chain.domain, args)) continue;
    rows.push(
      toNewTransfer(
        args,
        {
          srcDomain: opts.chain.domain,
          txHash: opts.txHash,
          logIndex: log.logIndex,
          blockNumber: receipt.blockNumber,
          blockTime: block ? Number(block.timestamp) : null,
        },
        opts.ctx,
      ),
    );
  }
  opts.store.insertTransfers(rows, opts.now);
  return rows;
}

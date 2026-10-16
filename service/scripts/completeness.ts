/**
 * Completeness check for the indexer: every USDC arrival on Injective
 * (MessageReceived) must match a burn the service indexed. An arrival with no
 * row means the indexer missed a burn; the reverse is fine (not yet minted).
 *
 *   DB_PATH=./data/bridge.sqlite tsx scripts/completeness.ts [skipMinutes]
 *
 * Each source chain is judged only on arrivals that landed at least
 * `skipMinutes` (default 60) after that chain's own coverage start, since a
 * burn just before the start can still arrive after it.
 */
import Database from "better-sqlite3";
import { createPublicClient, getAbiItem, http } from "viem";
import { CCTP_CONTRACTS, chainByKey, injective, messageTransmitterV2Abi } from "injective-usdc-bridge";

const dbPath = process.env.DB_PATH ?? "./data/bridge.sqlite";
const skipMinutes = Number(process.argv[2] ?? 60);
const db = new Database(dbPath, { readonly: true });
const inj = injective("mainnet");
const client = createPublicClient({ transport: http(inj.rpcUrls[0]) });
const SPAN = 5_000n;

const cursors = db.prepare("SELECT chain_key, block, start_block, start_time FROM cursors").all() as {
  chain_key: string;
  block: number;
  start_block: number | null;
  start_time: number | null;
}[];
const injCursor = cursors.find((c) => c.chain_key === "injective");
if (!injCursor?.start_block) throw new Error("Injective not indexed yet (or DB predates start tracking)");
const coverageStart = new Map<number, number>();
for (const c of cursors) {
  const chain = chainByKey("mainnet", c.chain_key);
  if (chain && c.start_time) coverageStart.set(chain.domain, c.start_time + skipMinutes * 60);
}

const from = BigInt(injCursor.start_block);
const head = BigInt(injCursor.block);
const event = getAbiItem({ abi: messageTransmitterV2Abi, name: "MessageReceived" });
const raw: { nonce: string; src: number; tx: string; block: bigint }[] = [];
for (let a = from; a <= head; a += SPAN) {
  const b = a + SPAN - 1n > head ? head : a + SPAN - 1n;
  const logs = await client.getLogs({ address: CCTP_CONTRACTS.mainnet.messageTransmitter, event, fromBlock: a, toBlock: b });
  for (const l of logs) raw.push({ nonce: l.args.nonce!.toLowerCase(), src: l.args.sourceDomain!, tx: l.transactionHash, block: l.blockNumber });
}
const blockTimes = new Map<bigint, number>();
for (const r of raw) {
  if (!blockTimes.has(r.block)) blockTimes.set(r.block, Number((await client.getBlock({ blockNumber: r.block })).timestamp));
}
const unindexedSources = new Map<number, number>();
const arrivals = raw.filter((r) => {
  const start = coverageStart.get(r.src);
  if (start === undefined) {
    unindexedSources.set(r.src, (unindexedSources.get(r.src) ?? 0) + 1);
    return false;
  }
  return blockTimes.get(r.block)! >= start;
});
for (const [src, n] of unindexedSources) console.log(`src ${src}: ${n} arrivals from a source this service does not index`);

const known = new Set(
  (db.prepare("SELECT event_nonce FROM transfers WHERE dst_domain = 29 AND event_nonce IS NOT NULL").all() as { event_nonce: string }[]).map(
    (r) => r.event_nonce,
  ),
);
const bySrc = new Map<number, { arrivals: number; matched: number; missing: string[] }>();
for (const a of arrivals) {
  const s = bySrc.get(a.src) ?? { arrivals: 0, matched: 0, missing: [] };
  s.arrivals++;
  if (known.has(a.nonce)) s.matched++;
  else s.missing.push(a.tx);
  bySrc.set(a.src, s);
}
console.log(`Injective blocks ${from}..${head}, ${arrivals.length} arrivals inside each source's coverage`);
for (const [src, s] of [...bySrc].sort((x, y) => x[0] - y[0])) {
  console.log(`src ${String(src).padStart(2)}  arrivals ${s.arrivals}  matched ${s.matched}  missing ${s.missing.length}${s.missing.length ? `  e.g. ${s.missing.slice(0, 3).join(", ")}` : ""}`);
}
const missing = [...bySrc.values()].reduce((n, s) => n + s.missing.length, 0);
console.log(missing === 0 ? "COMPLETE" : `${missing} arrivals with no indexed burn`);
process.exit(missing === 0 ? 0 : 1);

import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

/** Hex hashes compare lowercase; base58 Solana signatures are case-sensitive. */
const txKey = (tx: string) => (tx.startsWith("0x") ? tx.toLowerCase() : tx);

export type Direction = "deposit" | "withdraw";
export type Phase = "not_found" | "attesting" | "ready" | "expired" | "delivered";
/**
 * plain: destinationCaller 0, no hook. forward: asked Circle to mint.
 * gas_drop: pinned to our BridgeReceiver. legacy_gas_drop: pinned to a v1
 * GasDropReceiver. pinned_other: someone else's caller; only they can mint.
 */
export type Kind = "plain" | "forward" | "gas_drop" | "legacy_gas_drop" | "pinned_other";
export type MintedBy = "circle" | "relayer" | "unknown";

export interface TransferRow {
  src_domain: number;
  tx_hash: string;
  log_index: number;
  dst_domain: number;
  direction: Direction;
  block_number: number;
  block_time: number | null;
  depositor: string;
  mint_recipient: string;
  recipient: string | null;
  destination_caller: string;
  amount: string;
  max_fee: string;
  min_finality: number;
  hook_data: string;
  kind: Kind;
  phase: Phase;
  event_nonce: string | null;
  message: string | null;
  attestation: string | null;
  fee_executed: string | null;
  forward_state: string | null;
  forward_tx: string | null;
  mint_tx: string | null;
  minted_by: MintedBy | null;
  relay_attempts: number;
  last_error: string | null;
  first_seen: number;
  updated_at: number;
  attested_at: number | null;
  delivered_at: number | null;
  next_check_at: number;
  next_relay_at: number;
  /** Last time the tracker asked Iris about it; null until the first check. */
  checked_at: number | null;
  /** Solana burns: the MessageSent account whose rent the depositor can reclaim. */
  event_account: string | null;
}

export type NewTransfer = Partial<Pick<TransferRow, "event_account">> & Pick<
  TransferRow,
  | "src_domain"
  | "tx_hash"
  | "log_index"
  | "dst_domain"
  | "direction"
  | "block_number"
  | "block_time"
  | "depositor"
  | "mint_recipient"
  | "recipient"
  | "destination_caller"
  | "amount"
  | "max_fee"
  | "min_finality"
  | "hook_data"
  | "kind"
>;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS transfers (
  src_domain INTEGER NOT NULL,
  tx_hash TEXT NOT NULL,
  log_index INTEGER NOT NULL,
  dst_domain INTEGER NOT NULL,
  direction TEXT NOT NULL,
  block_number INTEGER NOT NULL,
  block_time INTEGER,
  depositor TEXT NOT NULL,
  mint_recipient TEXT NOT NULL,
  recipient TEXT,
  destination_caller TEXT NOT NULL,
  amount TEXT NOT NULL,
  max_fee TEXT NOT NULL,
  min_finality INTEGER NOT NULL,
  hook_data TEXT NOT NULL,
  kind TEXT NOT NULL,
  phase TEXT NOT NULL,
  event_nonce TEXT,
  message TEXT,
  attestation TEXT,
  fee_executed TEXT,
  forward_state TEXT,
  forward_tx TEXT,
  mint_tx TEXT,
  minted_by TEXT,
  relay_attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  first_seen INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  attested_at INTEGER,
  delivered_at INTEGER,
  next_check_at INTEGER NOT NULL,
  next_relay_at INTEGER NOT NULL DEFAULT 0,
  checked_at INTEGER,
  event_account TEXT,
  PRIMARY KEY (src_domain, tx_hash, log_index)
);
CREATE INDEX IF NOT EXISTS transfers_due ON transfers (phase, next_check_at);
CREATE INDEX IF NOT EXISTS transfers_depositor ON transfers (depositor, block_number);
CREATE INDEX IF NOT EXISTS transfers_recipient ON transfers (recipient, block_number);
CREATE INDEX IF NOT EXISTS transfers_tx ON transfers (tx_hash);
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS cursors (
  chain_key TEXT PRIMARY KEY,
  block INTEGER NOT NULL,
  head INTEGER,
  updated_at INTEGER NOT NULL,
  start_block INTEGER,
  start_time INTEGER
);
`;

const OPEN_PHASES = "('not_found','attesting','ready','expired')";

export class Store {
  readonly db: Database.Database;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("busy_timeout = 5000");
    this.db.exec(SCHEMA);
    // Columns added after the first deploy; CREATE TABLE IF NOT EXISTS skips them on an existing file.
    const columns = new Set((this.db.prepare("PRAGMA table_info(transfers)").all() as { name: string }[]).map((c) => c.name));
    if (!columns.has("event_account")) this.db.exec("ALTER TABLE transfers ADD COLUMN event_account TEXT");
    // Before 2026-10-17 a transfer first met already delivered (a backfill, an
    // old lookup) was dated when the service noticed it. Forget those dates:
    // seen well after the burn, marked delivered at first sight, by someone
    // other than our relayer, with no mint tx to read a time from.
    this.once("delivered_at_unknown", () =>
      this.db
        .prepare(
          `UPDATE transfers SET delivered_at = NULL
           WHERE delivered_at IS NOT NULL AND mint_tx IS NULL AND COALESCE(minted_by, '') <> 'relayer'
             AND first_seen - COALESCE(block_time * 1000, first_seen) > 300000
             AND delivered_at - first_seen < 600000`,
        )
        .run(),
    );
  }

  /** Runs a data fix once per database. */
  private once(key: string, fix: () => void): void {
    if (this.db.prepare("SELECT 1 FROM meta WHERE key = ?").get(key)) return;
    this.db.transaction(() => {
      fix();
      this.db.prepare("INSERT INTO meta (key, value) VALUES (?, ?)").run(key, new Date().toISOString());
    })();
  }

  close(): void {
    this.db.close();
  }

  // ---------------------------------------------------------------- cursors

  getCursor(chainKey: string): number | undefined {
    const row = this.db.prepare("SELECT block FROM cursors WHERE chain_key = ?").get(chainKey) as
      | { block: number }
      | undefined;
    return row?.block;
  }

  setCursor(chainKey: string, block: number, head: number, now: number): void {
    this.db
      .prepare(
        `INSERT INTO cursors (chain_key, block, head, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(chain_key) DO UPDATE SET block = excluded.block, head = excluded.head, updated_at = excluded.updated_at`,
      )
      .run(chainKey, block, head, now);
  }

  /** First block indexed on a chain and its timestamp (unix s): where coverage begins. */
  setCursorStart(chainKey: string, startBlock: number, startTime: number, now: number): void {
    this.db
      .prepare(
        `INSERT INTO cursors (chain_key, block, head, updated_at, start_block, start_time) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(chain_key) DO UPDATE SET start_block = excluded.start_block, start_time = excluded.start_time`,
      )
      .run(chainKey, startBlock - 1, startBlock - 1, now, startBlock, startTime);
  }

  cursors(): {
    chain_key: string;
    block: number;
    head: number | null;
    updated_at: number;
    start_block: number | null;
    start_time: number | null;
  }[] {
    return this.db.prepare("SELECT * FROM cursors").all() as never;
  }

  // -------------------------------------------------------------- transfers

  /** Insert burns; existing rows are left untouched. Returns how many were new. */
  insertTransfers(rows: NewTransfer[], now: number): number {
    const stmt = this.db.prepare(
      `INSERT OR IGNORE INTO transfers (
        src_domain, tx_hash, log_index, dst_domain, direction, block_number, block_time,
        depositor, mint_recipient, recipient, destination_caller, amount, max_fee,
        min_finality, hook_data, kind, phase, first_seen, updated_at, next_check_at, event_account
      ) VALUES (
        @src_domain, @tx_hash, @log_index, @dst_domain, @direction, @block_number, @block_time,
        @depositor, @mint_recipient, @recipient, @destination_caller, @amount, @max_fee,
        @min_finality, @hook_data, @kind, 'not_found', @now, @now, @now, @event_account
      )`,
    );
    let added = 0;
    this.db.transaction(() => {
      for (const r of rows) added += stmt.run({ event_account: null, ...r, now }).changes;
    })();
    return added;
  }

  get(srcDomain: number, txHash: string, logIndex: number): TransferRow | undefined {
    return this.db
      .prepare("SELECT * FROM transfers WHERE src_domain = ? AND tx_hash = ? AND log_index = ?")
      .get(srcDomain, txKey(txHash), logIndex) as TransferRow | undefined;
  }

  byTx(srcDomain: number, txHash: string): TransferRow[] {
    return this.db
      .prepare("SELECT * FROM transfers WHERE src_domain = ? AND tx_hash = ? ORDER BY log_index")
      .all(srcDomain, txKey(txHash)) as TransferRow[];
  }

  /** A source tx on whichever chain it was sent from, for lookups that know only the hash. */
  byTxAnyDomain(txHash: string): TransferRow[] {
    return this.db.prepare("SELECT * FROM transfers WHERE tx_hash = ? ORDER BY src_domain, log_index").all(txKey(txHash)) as TransferRow[];
  }

  /** Open transfers whose next check is due, grouped by source tx. */
  dueTxs(now: number, limit: number): { src_domain: number; tx_hash: string }[] {
    return this.db
      .prepare(
        `SELECT src_domain, tx_hash FROM transfers
         WHERE phase IN ${OPEN_PHASES} AND next_check_at <= ?
         GROUP BY src_domain, tx_hash
         ORDER BY MIN(next_check_at) LIMIT ?`,
      )
      .all(now, limit) as { src_domain: number; tx_hash: string }[];
  }

  /** Attested deposits into `dstDomain` that we may mint now. */
  relayCandidates(dstDomain: number, kinds: string[], now: number, limit: number): TransferRow[] {
    const placeholders = kinds.map(() => "?").join(",");
    return this.db
      .prepare(
        `SELECT * FROM transfers
         WHERE phase = 'ready' AND dst_domain = ? AND kind IN (${placeholders})
           AND next_relay_at <= ?
         ORDER BY attested_at LIMIT ?`,
      )
      .all(dstDomain, ...kinds, now, limit) as TransferRow[];
  }

  update(row: Pick<TransferRow, "src_domain" | "tx_hash" | "log_index">, patch: Partial<TransferRow>, now: number): void {
    const keys = Object.keys(patch).filter((k) => !["src_domain", "tx_hash", "log_index"].includes(k));
    if (keys.length === 0) return;
    const set = [...keys.map((k) => `${k} = @${k}`), "updated_at = @updated_at"].join(", ");
    this.db
      .prepare(
        `UPDATE transfers SET ${set} WHERE src_domain = @src_domain AND tx_hash = @tx_hash AND log_index = @log_index`,
      )
      .run({ ...patch, updated_at: now, src_domain: row.src_domain, tx_hash: row.tx_hash, log_index: row.log_index });
  }

  /** Transfers where `address` (0x lowercase, or a base58 Solana wallet) sent or receives. Newest first. */
  byAddress(address: string, limit: number, beforeBlockTime?: number): TransferRow[] {
    const a = txKey(address);
    const before = beforeBlockTime ?? Number.MAX_SAFE_INTEGER;
    return this.db
      .prepare(
        `SELECT * FROM transfers
         WHERE (depositor = ? OR recipient = ?) AND COALESCE(block_time, first_seen / 1000) < ?
         ORDER BY COALESCE(block_time, first_seen / 1000) DESC LIMIT ?`,
      )
      .all(a, a, before, limit) as TransferRow[];
  }

  /** Transfers into `dstDomain` whose receiving wallet is not known, in any phase. */
  missingRecipients(dstDomain: number, limit: number): TransferRow[] {
    return this.db
      .prepare("SELECT * FROM transfers WHERE dst_domain = ? AND recipient IS NULL ORDER BY first_seen DESC LIMIT ?")
      .all(dstDomain, limit) as TransferRow[];
  }

  phaseCounts(): Record<string, number> {
    const rows = this.db.prepare("SELECT phase, COUNT(*) AS n FROM transfers GROUP BY phase").all() as {
      phase: string;
      n: number;
    }[];
    return Object.fromEntries(rows.map((r) => [r.phase, r.n]));
  }

  /**
   * Oldest still-attesting burn per source domain, for Iris lane health. Only
   * burns Iris has been asked about count: a backfill's unchecked rows are
   * old but say nothing about Circle.
   */
  oldestAttesting(): { src_domain: number; min_finality: number; since: number; n: number }[] {
    return this.db
      .prepare(
        `SELECT src_domain, min_finality, MIN(COALESCE(block_time * 1000, first_seen)) AS since, COUNT(*) AS n
         FROM transfers WHERE phase IN ('not_found','attesting') AND checked_at IS NOT NULL
         GROUP BY src_domain, min_finality`,
      )
      .all() as { src_domain: number; min_finality: number; since: number; n: number }[];
  }

  /** Latest attestation we saw per source domain. */
  lastAttested(): { src_domain: number; at: number }[] {
    return this.db
      .prepare("SELECT src_domain, MAX(attested_at) AS at FROM transfers WHERE attested_at IS NOT NULL GROUP BY src_domain")
      .all() as { src_domain: number; at: number }[];
  }
}

/**
 * Every burn this browser signed, kept until the service has it. v1 kept one
 * slot and lost transfers when a second one overwrote it; this is a list, and
 * the service, not this list, is the record. It only covers the seconds
 * between signing and the service indexing the transaction, and a service
 * outage.
 */

export interface JournalEntry {
  domain: number;
  txHash: string;
  /** Who signed it, lowercase 0x. */
  address: string;
  at: number;
}

const KEY = "injective-usdc-bridge:journal:v1";
const MAX_ENTRIES = 50;
const MAX_AGE_MS = 30 * 24 * 3600_000;

type Store = Pick<Storage, "getItem" | "setItem">;

const entryKey = (e: JournalEntry) => `${e.domain}:${e.txHash.toLowerCase()}`;

function defaultStore(): Store | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

export class Journal {
  private memory: JournalEntry[] = [];

  constructor(private readonly store: Store | null = defaultStore()) {}

  list(now = Date.now()): JournalEntry[] {
    let stored: JournalEntry[] = [];
    try {
      const raw = this.store?.getItem(KEY);
      if (raw) stored = JSON.parse(raw) as JournalEntry[];
    } catch {
      // Unreadable storage: this session's memory still counts.
    }
    const seen = new Set(stored.map(entryKey));
    return [...stored, ...this.memory.filter((e) => !seen.has(entryKey(e)))].filter((e) => now - e.at < MAX_AGE_MS);
  }

  add(entry: JournalEntry): void {
    const entries = [entry, ...this.list(entry.at).filter((e) => entryKey(e) !== entryKey(entry))].slice(0, MAX_ENTRIES);
    this.memory = entries;
    try {
      this.store?.setItem(KEY, JSON.stringify(entries));
    } catch {
      // Private mode or full storage: memory still has it for this session.
    }
  }

  forAddress(address: string, now = Date.now()): JournalEntry[] {
    const a = address.toLowerCase();
    return this.list(now).filter((e) => e.address === a);
  }
}

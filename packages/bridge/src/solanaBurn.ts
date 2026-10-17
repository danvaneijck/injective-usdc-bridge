import { ed25519 } from "@noble/curves/ed25519";
import { sha256 } from "@noble/hashes/sha2";
import { base58, base64 } from "@scure/base";
import { type Address, type Hex, bytesToHex, hexToBytes, isAddress } from "viem";
import { INJECTIVE_DOMAIN, type SolanaChain } from "./chains.js";
import { ZERO_BYTES32 } from "./constants.js";
import { encodeGasDropHook } from "./gasDrop.js";
import { addressToBytes32 } from "./message.js";
import { type Quote, type Route, RouteError } from "./quote.js";
import {
  COMPUTE_BUDGET_PROGRAM,
  SOLANA_MESSAGE_TRANSMITTER_V2,
  SOLANA_TOKEN_MESSENGER_MINTER_V2,
  SPL_TOKEN_PROGRAM,
  SYSTEM_PROGRAM,
  associatedTokenAddress,
  findProgramAddress,
  isWalletAddress,
  solanaRpc,
} from "./solana.js";

/**
 * Circle's CCTP V2 burn on Solana, built by hand: the instruction layout,
 * account order and PDA seeds follow Circle's solana-cctp-contracts V2 example
 * (and v1's tested port), and the transaction is serialised here rather than
 * pulling a Solana SDK into every page that embeds the widget. The tests check
 * the bytes against @solana/web3.js.
 */

export interface SolanaAccountMeta {
  pubkey: string;
  isSigner: boolean;
  isWritable: boolean;
}

export interface SolanaInstruction {
  programId: string;
  keys: SolanaAccountMeta[];
  data: Uint8Array;
}

const utf8 = (s: string) => new TextEncoder().encode(s);
const anchorDiscriminator = (name: string) => sha256(utf8(`global:${name}`)).slice(0, 8);

export const DEPOSIT_FOR_BURN_DISCRIMINATOR = anchorDiscriminator("deposit_for_burn");
export const DEPOSIT_FOR_BURN_WITH_HOOK_DISCRIMINATOR = anchorDiscriminator("deposit_for_burn_with_hook");

/** Positions in the burn instruction's account list (both variants share it). */
export const SOLANA_BURN_ACCOUNTS = {
  owner: 0,
  eventRentPayer: 1,
  burnTokenAccount: 3,
  remoteTokenMessenger: 7,
  burnTokenMint: 10,
  messageSentEventData: 11,
} as const;

export interface SolanaBurnArgs {
  amount: bigint;
  destinationDomain: number;
  mintRecipient: Hex;
  destinationCaller: Hex;
  maxFee: bigint;
  minFinalityThreshold: number;
  /** Present: deposit_for_burn_with_hook. Absent: deposit_for_burn. */
  hookData?: Hex;
}

/** Borsh: u64 amount, u32 domain, [32] recipient, [32] caller, u64 maxFee, u32 finality, then Vec<u8> hook. */
function encodeBurnArgs(a: SolanaBurnArgs): Uint8Array {
  const hook = a.hookData === undefined ? null : hexToBytes(a.hookData);
  const out = new Uint8Array(8 + 88 + (hook ? 4 + hook.length : 0));
  const v = new DataView(out.buffer);
  out.set(a.hookData === undefined ? DEPOSIT_FOR_BURN_DISCRIMINATOR : DEPOSIT_FOR_BURN_WITH_HOOK_DISCRIMINATOR, 0);
  v.setBigUint64(8, a.amount, true);
  v.setUint32(16, a.destinationDomain, true);
  out.set(hexToBytes(a.mintRecipient), 20);
  out.set(hexToBytes(a.destinationCaller), 52);
  v.setBigUint64(84, a.maxFee, true);
  v.setUint32(92, a.minFinalityThreshold, true);
  if (hook) {
    v.setUint32(96, hook.length, true);
    out.set(hook, 100);
  }
  return out;
}

/** The inverse, for the indexer. Null for any other instruction. */
export function decodeSolanaBurn(data: Uint8Array): (Required<Omit<SolanaBurnArgs, "hookData">> & { hookData: Hex; withHook: boolean }) | null {
  if (data.length < 96) return null;
  const head = data.slice(0, 8);
  const same = (d: Uint8Array) => d.every((b, i) => head[i] === b);
  const withHook = same(DEPOSIT_FOR_BURN_WITH_HOOK_DISCRIMINATOR);
  if (!withHook && !same(DEPOSIT_FOR_BURN_DISCRIMINATOR)) return null;
  const v = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let hookData: Hex = "0x";
  if (withHook) {
    if (data.length < 100) return null;
    const len = v.getUint32(96, true);
    if (data.length < 100 + len) return null;
    hookData = bytesToHex(data.slice(100, 100 + len));
  }
  return {
    withHook,
    amount: v.getBigUint64(8, true),
    destinationDomain: v.getUint32(16, true),
    mintRecipient: bytesToHex(data.slice(20, 52)),
    destinationCaller: bytesToHex(data.slice(52, 84)),
    maxFee: v.getBigUint64(84, true),
    minFinalityThreshold: v.getUint32(92, true),
    hookData,
  };
}

/** deposit_for_burn(_with_hook): the owner pays and also funds the event account's rent. */
export function depositForBurnInstruction(p: {
  owner: string;
  mint: string;
  messageSentEventData: string;
  args: SolanaBurnArgs;
}): SolanaInstruction {
  const tmm = SOLANA_TOKEN_MESSENGER_MINTER_V2;
  const mt = SOLANA_MESSAGE_TRANSMITTER_V2;
  const pda = (program: string, ...seeds: Uint8Array[]) => findProgramAddress(seeds, program);
  const owner = base58.decode(p.owner);
  const ro = (pubkey: string): SolanaAccountMeta => ({ pubkey, isSigner: false, isWritable: false });
  const rw = (pubkey: string): SolanaAccountMeta => ({ pubkey, isSigner: false, isWritable: true });
  return {
    programId: tmm,
    keys: [
      { pubkey: p.owner, isSigner: true, isWritable: true },
      { pubkey: p.owner, isSigner: true, isWritable: true }, // event rent payer
      ro(pda(tmm, utf8("sender_authority"))),
      rw(associatedTokenAddress(p.owner, p.mint)),
      ro(pda(tmm, utf8("denylist_account"), owner)),
      rw(pda(mt, utf8("message_transmitter"))),
      ro(pda(tmm, utf8("token_messenger"))),
      ro(pda(tmm, utf8("remote_token_messenger"), utf8(String(p.args.destinationDomain)))),
      ro(pda(tmm, utf8("token_minter"))),
      rw(pda(tmm, utf8("local_token"), base58.decode(p.mint))),
      rw(p.mint),
      { pubkey: p.messageSentEventData, isSigner: true, isWritable: true },
      ro(mt),
      ro(tmm),
      ro(SPL_TOKEN_PROGRAM),
      ro(SYSTEM_PROGRAM),
      // #[event_cpi] appends the event authority and the program itself.
      ro(pda(tmm, utf8("__event_authority"))),
      ro(tmm),
    ],
    data: encodeBurnArgs(p.args),
  };
}

export function computeBudgetInstructions(units: number, microLamports: number): SolanaInstruction[] {
  const limit = new Uint8Array(5);
  limit[0] = 2;
  new DataView(limit.buffer).setUint32(1, units, true);
  const price = new Uint8Array(9);
  price[0] = 3;
  new DataView(price.buffer).setBigUint64(1, BigInt(microLamports), true);
  return [
    { programId: COMPUTE_BUDGET_PROGRAM, keys: [], data: limit },
    { programId: COMPUTE_BUDGET_PROGRAM, keys: [], data: price },
  ];
}

// ── Legacy transaction wire format ───────────────────────────────────────────

function shortVec(n: number): number[] {
  const out: number[] = [];
  let rest = n;
  for (;;) {
    let byte = rest & 0x7f;
    rest >>= 7;
    if (rest === 0) {
      out.push(byte);
      return out;
    }
    byte |= 0x80;
    out.push(byte);
  }
}

export interface CompiledMessage {
  bytes: Uint8Array;
  /** Signer addresses in signature order (fee payer first). */
  signers: string[];
}

/**
 * Legacy message, keys ordered exactly as @solana/web3.js' compileToLegacyMessage
 * does: payer, then every program and account in first-seen order, grouped as
 * writable signers, read-only signers, writable, read-only.
 */
export function compileLegacyMessage(feePayer: string, instructions: SolanaInstruction[], recentBlockhash: string): CompiledMessage {
  const metas = new Map<string, { signer: boolean; writable: boolean }>();
  const touch = (key: string, signer: boolean, writable: boolean) => {
    const m = metas.get(key) ?? { signer: false, writable: false };
    m.signer ||= signer;
    m.writable ||= writable;
    metas.set(key, m);
  };
  touch(feePayer, true, true);
  for (const ix of instructions) {
    touch(ix.programId, false, false);
    for (const k of ix.keys) touch(k.pubkey, k.isSigner, k.isWritable);
  }
  const all = [...metas.entries()];
  const group = (signer: boolean, writable: boolean) =>
    all.filter(([, m]) => m.signer === signer && m.writable === writable).map(([k]) => k);
  const keys = [...group(true, true), ...group(true, false), ...group(false, true), ...group(false, false)];
  const index = new Map(keys.map((k, i) => [k, i]));
  const signers = keys.filter((k) => metas.get(k)!.signer);

  const out: number[] = [
    signers.length,
    group(true, false).length,
    group(false, false).length,
    ...shortVec(keys.length),
  ];
  for (const k of keys) out.push(...base58.decode(k));
  out.push(...base58.decode(recentBlockhash));
  out.push(...shortVec(instructions.length));
  for (const ix of instructions) {
    out.push(index.get(ix.programId)!);
    out.push(...shortVec(ix.keys.length), ...ix.keys.map((k) => index.get(k.pubkey)!));
    out.push(...shortVec(ix.data.length), ...ix.data);
  }
  return { bytes: new Uint8Array(out), signers };
}

/** An address lookup table as read from chain: entries keep their index for life (tables are append-only). */
export interface AddressLookupTable {
  address: string;
  addresses: readonly string[];
}

/**
 * Version 0 message, compiled as @solana/web3.js' compileToV0Message does:
 * every account that is neither a signer nor an invoked program and appears
 * in a table is loaded from it; the rest stay inline in legacy order. Loaded
 * accounts index after the inline ones, all writable before all read-only.
 */
export function compileV0Message(
  feePayer: string,
  instructions: SolanaInstruction[],
  recentBlockhash: string,
  tables: readonly AddressLookupTable[],
): CompiledMessage {
  const metas = new Map<string, { signer: boolean; writable: boolean; invoked: boolean }>();
  const touch = (key: string, signer: boolean, writable: boolean, invoked = false) => {
    const m = metas.get(key) ?? { signer: false, writable: false, invoked: false };
    m.signer ||= signer;
    m.writable ||= writable;
    m.invoked ||= invoked;
    metas.set(key, m);
  };
  touch(feePayer, true, true);
  for (const ix of instructions) {
    touch(ix.programId, false, false, true);
    for (const k of ix.keys) touch(k.pubkey, k.isSigner, k.isWritable);
  }

  const lookups: { address: string; writable: number[]; readonly: number[] }[] = [];
  const loadedWritable: string[] = [];
  const loadedReadonly: string[] = [];
  for (const table of tables) {
    const drain = (writable: boolean) => {
      const indexes: number[] = [];
      const keys: string[] = [];
      for (const [key, m] of metas) {
        if (m.signer || m.invoked || m.writable !== writable) continue;
        const i = table.addresses.indexOf(key);
        if (i < 0) continue;
        if (i > 255) throw new Error("Lookup table index out of range");
        indexes.push(i);
        keys.push(key);
        metas.delete(key);
      }
      return { indexes, keys };
    };
    const w = drain(true);
    const r = drain(false);
    if (w.indexes.length === 0 && r.indexes.length === 0) continue;
    lookups.push({ address: table.address, writable: w.indexes, readonly: r.indexes });
    loadedWritable.push(...w.keys);
    loadedReadonly.push(...r.keys);
  }

  const all = [...metas.entries()];
  const group = (signer: boolean, writable: boolean) =>
    all.filter(([, m]) => m.signer === signer && m.writable === writable).map(([k]) => k);
  const keys = [...group(true, true), ...group(true, false), ...group(false, true), ...group(false, false)];
  const index = new Map([...keys, ...loadedWritable, ...loadedReadonly].map((k, i) => [k, i]));
  const signers = keys.filter((k) => metas.get(k)!.signer);

  const out: number[] = [0x80, signers.length, group(true, false).length, group(false, false).length, ...shortVec(keys.length)];
  for (const k of keys) out.push(...base58.decode(k));
  out.push(...base58.decode(recentBlockhash));
  out.push(...shortVec(instructions.length));
  for (const ix of instructions) {
    out.push(index.get(ix.programId)!);
    out.push(...shortVec(ix.keys.length), ...ix.keys.map((k) => index.get(k.pubkey)!));
    out.push(...shortVec(ix.data.length), ...ix.data);
  }
  out.push(...shortVec(lookups.length));
  for (const l of lookups) {
    out.push(...base58.decode(l.address));
    out.push(...shortVec(l.writable.length), ...l.writable);
    out.push(...shortVec(l.readonly.length), ...l.readonly);
  }
  return { bytes: new Uint8Array(out), signers };
}

/** Solana's hard limit on a whole wire transaction. */
export const SOLANA_MAX_TRANSACTION_BYTES = 1232;

/** Wire transaction: signature count, signatures (zeros where still missing), message. */
export function serializeTransaction(message: CompiledMessage, signatures: Map<string, Uint8Array>): Uint8Array {
  const head = shortVec(message.signers.length);
  const out = new Uint8Array(head.length + 64 * message.signers.length + message.bytes.length);
  out.set(head, 0);
  message.signers.forEach((s, i) => {
    const sig = signatures.get(s);
    if (sig) out.set(sig, head.length + 64 * i);
  });
  out.set(message.bytes, head.length + 64 * message.signers.length);
  return out;
}

/** A transaction's id: its first (fee payer's) signature. */
export function transactionSignature(wire: Uint8Array): string {
  const sig = wire.slice(1, 65);
  if (sig.every((b) => b === 0)) throw new Error("Transaction is not signed by its fee payer");
  return base58.encode(sig);
}

// ── Simulate, then budget ────────────────────────────────────────────────────

/** Bounds on the priority fee, in lamports for the whole transaction (v1's, in use since August). */
const MIN_PRIORITY_LAMPORTS = 10_000;
const MAX_PRIORITY_LAMPORTS = 200_000;
const COMPUTE_FALLBACK = 200_000;

export interface PreparedSolanaTransaction {
  message: CompiledMessage;
  lastValidBlockHeight: number;
  /** Signature fees plus the priority fee, in lamports. */
  feeLamports: bigint;
}

/**
 * Simulates the instructions (a transaction the program would reject is
 * refused here with its reason, before anyone signs), then compiles them
 * behind a compute limit sized from the simulation and a priority fee priced
 * off recent fees on `priorityAccounts`. Legacy without tables, v0 with them.
 */
export async function prepareSolanaTransaction(p: {
  rpcUrls: readonly string[];
  payer: string;
  instructions: SolanaInstruction[];
  priorityAccounts: string[];
  tables?: readonly AddressLookupTable[];
  fetchImpl?: typeof fetch;
}): Promise<PreparedSolanaTransaction> {
  const rpc = <T>(method: string, params: unknown[]) => solanaRpc<T>(p.rpcUrls, method, params, p.fetchImpl);
  const compile = (ixs: SolanaInstruction[], blockhash: string) =>
    p.tables ? compileV0Message(p.payer, ixs, blockhash, p.tables) : compileLegacyMessage(p.payer, ixs, blockhash);

  const { value: latest } = await rpc<{ value: { blockhash: string; lastValidBlockHeight: number } }>("getLatestBlockhash", [
    { commitment: "confirmed" },
  ]);

  // Simulate with a generous limit to learn the real compute use.
  const probe = compile([...computeBudgetInstructions(400_000, 0), ...p.instructions], latest.blockhash);
  const size = serializeTransaction(probe, new Map()).length;
  if (size > SOLANA_MAX_TRANSACTION_BYTES) {
    throw new Error(`Solana transaction is ${size} bytes, over the ${SOLANA_MAX_TRANSACTION_BYTES}-byte limit`);
  }
  const sim = await rpc<{ value: { err: unknown; logs: string[] | null; unitsConsumed?: number } }>("simulateTransaction", [
    base64.encode(serializeTransaction(probe, new Map())),
    { encoding: "base64", sigVerify: false, replaceRecentBlockhash: true, commitment: "confirmed" },
  ]);
  if (sim.value.err) throw new SolanaSimulationError(sim.value.err, sim.value.logs ?? []);
  const units = sim.value.unitsConsumed ? Math.ceil(sim.value.unitsConsumed * 1.2) + 1_000 : COMPUTE_FALLBACK;

  const recent = await rpc<{ prioritizationFee: number }[]>("getRecentPrioritizationFees", [p.priorityAccounts]).catch(() => []);
  const microLamports = priorityMicroLamports(recent.map((r) => r.prioritizationFee), units);

  const message = compile([...computeBudgetInstructions(units, microLamports), ...p.instructions], latest.blockhash);
  const feeLamports = BigInt(5_000 * message.signers.length) + BigInt(Math.ceil((units * microLamports) / 1e6));
  return { message, lastValidBlockHeight: latest.lastValidBlockHeight, feeLamports };
}

// ── Building a burn ──────────────────────────────────────────────────────────

export interface SolanaBurnPlan {
  /** Signed by the one-off event account; the owner's signature goes in next. */
  transaction: Uint8Array;
  eventAccount: string;
  lastValidBlockHeight: number;
  /** Fees plus the event account's rent, which the owner pays (reclaimable later). */
  costLamports: bigint;
  mintRecipient: Hex;
  destinationCaller: Hex;
  hookData: Hex;
}

export interface BuildSolanaBurnOptions {
  route: Route;
  quote: Quote;
  /** Wallet that holds the USDC and pays. */
  owner: string;
  /** EVM address that receives the USDC on Injective. */
  recipient: string;
  gasDrop?: { receiver: Address; maxDropFee: bigint };
  rpcUrls?: readonly string[];
  fetchImpl?: typeof fetch;
  /** Test seam for the event account's key. */
  eventKey?: Uint8Array;
}

/**
 * A ready-to-sign Solana burn to Injective. Simulated first, so a burn that
 * would fail (no USDC, no SOL) is refused here with the program's reason
 * instead of costing the user a failed transaction.
 */
export async function buildSolanaBurn(opts: BuildSolanaBurnOptions): Promise<SolanaBurnPlan> {
  const { route, quote } = opts;
  if (route.source.kind !== "solana") throw new RouteError(`${route.source.name} is not Solana`);
  if (route.destination.domain !== INJECTIVE_DOMAIN || quote.direction !== "deposit") {
    throw new RouteError("Solana burns here go to Injective only");
  }
  if (!isWalletAddress(opts.owner)) throw new RouteError(`${opts.owner} is not a Solana wallet`);
  if (!isAddress(opts.recipient)) throw new RouteError(`Recipient ${opts.recipient} is not an EVM address`);
  const chain: SolanaChain = route.source;
  const rpcUrls = opts.rpcUrls ?? chain.rpcUrls;

  let mintRecipient: Hex;
  let destinationCaller: Hex;
  let hookData: Hex | undefined;
  if (opts.gasDrop) {
    if (!isAddress(opts.gasDrop.receiver)) throw new RouteError("Gas drop receiver is not an EVM address");
    mintRecipient = addressToBytes32(opts.gasDrop.receiver);
    destinationCaller = mintRecipient;
    hookData = encodeGasDropHook(opts.recipient as Address, opts.gasDrop.maxDropFee);
  } else {
    mintRecipient = addressToBytes32(opts.recipient as Address);
    destinationCaller = ZERO_BYTES32;
  }

  const eventKey = opts.eventKey ?? ed25519.utils.randomPrivateKey();
  const eventAccount = base58.encode(ed25519.getPublicKey(eventKey));
  const burn = depositForBurnInstruction({
    owner: opts.owner,
    mint: chain.usdcMint,
    messageSentEventData: eventAccount,
    args: {
      amount: quote.amount,
      destinationDomain: route.destination.domain,
      mintRecipient,
      destinationCaller,
      maxFee: quote.maxFee,
      minFinalityThreshold: quote.minFinalityThreshold,
      ...(hookData ? { hookData } : {}),
    },
  });

  const prepared = await prepareSolanaTransaction({
    rpcUrls,
    payer: opts.owner,
    instructions: [burn],
    priorityAccounts: [chain.usdcMint, findProgramAddress([utf8("message_transmitter")], SOLANA_MESSAGE_TRANSMITTER_V2)],
    ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
  });
  const { message } = prepared;
  const transaction = serializeTransaction(message, new Map([[eventAccount, ed25519.sign(message.bytes, eventKey)]]));

  const rent = await solanaRpc<number>(rpcUrls, "getMinimumBalanceForRentExemption", [eventAccountSize(hookData)], opts.fetchImpl).catch(
    () => 4_600_000,
  );

  return {
    transaction,
    eventAccount,
    lastValidBlockHeight: prepared.lastValidBlockHeight,
    costLamports: prepared.feeLamports + BigInt(rent),
    mintRecipient,
    destinationCaller,
    hookData: hookData ?? "0x",
  };
}

/** MessageSent account: discriminator, rent payer, created_at, Vec<u8> message (header 148 + burn body 228 + hook). */
function eventAccountSize(hookData: Hex | undefined): number {
  const hook = hookData ? (hookData.length - 2) / 2 : 0;
  return 8 + 32 + 8 + 4 + 148 + 228 + hook;
}

/** The 75th percentile of recent fees, kept between the lamport bounds above. */
export function priorityMicroLamports(recent: number[], units: number): number {
  const sorted = recent.filter((f) => f > 0).sort((a, b) => a - b);
  const p75 = sorted.length ? sorted[Math.floor(sorted.length * 0.75)]! : 0;
  const floor = Math.ceil((MIN_PRIORITY_LAMPORTS * 1e6) / units);
  const ceiling = Math.floor((MAX_PRIORITY_LAMPORTS * 1e6) / units);
  return Math.min(Math.max(p75, floor), ceiling);
}

export class SolanaSimulationError extends Error {
  constructor(
    readonly err: unknown,
    readonly logs: string[],
  ) {
    super(describeSimulationFailure(err, logs));
    this.name = "SolanaSimulationError";
  }
}

function describeSimulationFailure(err: unknown, logs: string[]): string {
  const text = `${JSON.stringify(err)} ${logs.join(" ")}`;
  if (/insufficient lamports|InsufficientFundsForRent|AccountNotFound|"InsufficientFundsForFee"/.test(text)) return "Not enough SOL for the network fee";
  if (/insufficient funds/.test(text)) return "Not enough USDC on Solana";
  if (/Denylisted/.test(text)) return "This wallet cannot use CCTP";
  // receive_message creates the nonce's account; it exists once the mint happened.
  if (/already in use/.test(text)) return "This transfer was already delivered";
  if (/EventAccountWindowNotExpired/.test(text)) return "The deposit can be refunded 5 days after the transfer";
  const program = logs.find((l) => /Error Message:/.test(l));
  return program ? program.replace(/.*Error Message:\s*/, "") : `Simulation failed: ${JSON.stringify(err)}`;
}

/**
 * Sends a signed transaction and waits for it, rebroadcasting until it lands
 * or its blockhash expires (Solana drops transactions under load; sending
 * once is not enough).
 */
export async function submitSolanaTransaction(
  rpcUrls: readonly string[],
  wire: Uint8Array,
  lastValidBlockHeight: number,
  opts: { fetchImpl?: typeof fetch; sleep?: (ms: number) => Promise<void> } = {},
): Promise<string> {
  const signature = transactionSignature(wire);
  const encoded = base64.encode(wire);
  const sleep = opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const send = () =>
    solanaRpc<string>(rpcUrls, "sendTransaction", [encoded, { encoding: "base64", skipPreflight: true, maxRetries: 0 }], opts.fetchImpl);
  await send();
  for (let i = 0; ; i++) {
    await sleep(1_500);
    const { value } = await solanaRpc<{ value: ({ err: unknown; confirmationStatus?: string } | null)[] }>(
      rpcUrls,
      "getSignatureStatuses",
      [[signature]],
      opts.fetchImpl,
    );
    const status = value[0];
    if (status?.err) throw new Error(`Solana transaction failed: ${JSON.stringify(status.err)}`);
    if (status && (status.confirmationStatus === "confirmed" || status.confirmationStatus === "finalized")) return signature;
    if (i % 2 === 1) {
      const height = await solanaRpc<number>(rpcUrls, "getBlockHeight", [{ commitment: "confirmed" }], opts.fetchImpl);
      if (height > lastValidBlockHeight) throw new Error("The Solana transaction expired before it landed. Nothing was sent; try again.");
      await send().catch(() => undefined);
    }
  }
}

/** Waits for a signature the wallet broadcast itself. */
export async function confirmSolanaSignature(
  rpcUrls: readonly string[],
  signature: string,
  lastValidBlockHeight: number,
  opts: { fetchImpl?: typeof fetch; sleep?: (ms: number) => Promise<void> } = {},
): Promise<void> {
  const sleep = opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  for (let i = 0; ; i++) {
    await sleep(1_500);
    const { value } = await solanaRpc<{ value: ({ err: unknown; confirmationStatus?: string } | null)[] }>(
      rpcUrls,
      "getSignatureStatuses",
      [[signature]],
      opts.fetchImpl,
    );
    const status = value[0];
    if (status?.err) throw new Error(`Solana transaction failed: ${JSON.stringify(status.err)}`);
    if (status && (status.confirmationStatus === "confirmed" || status.confirmationStatus === "finalized")) return;
    if (i % 4 === 3) {
      const height = await solanaRpc<number>(rpcUrls, "getBlockHeight", [{ commitment: "confirmed" }], opts.fetchImpl);
      if (height > lastValidBlockHeight) throw new Error("The Solana transaction expired before it landed. Nothing was sent; try again.");
    }
  }
}

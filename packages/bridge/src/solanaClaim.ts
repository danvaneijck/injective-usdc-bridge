import { sha256 } from "@noble/hashes/sha2";
import { base58, base64 } from "@scure/base";
import { type Hex, bytesToHex, hexToBytes } from "viem";
import type { SolanaChain } from "./chains.js";
import { ZERO_BYTES32 } from "./constants.js";
import { decodeBurnMessage, decodeMessage } from "./message.js";
import {
  ASSOCIATED_TOKEN_PROGRAM,
  SOLANA_MESSAGE_TRANSMITTER_V2,
  SOLANA_TOKEN_MESSENGER_MINTER_V2,
  SPL_TOKEN_PROGRAM,
  SYSTEM_PROGRAM,
  type SolanaAccount,
  associatedTokenAddress,
  bytes32ToSolana,
  findProgramAddress,
  parseTokenAccount,
  solanaAccount,
  solanaRpc,
  solanaToBytes32,
  usedNonceAddress,
} from "./solana.js";
import {
  type AddressLookupTable,
  type SolanaAccountMeta,
  type SolanaInstruction,
  prepareSolanaTransaction,
  serializeTransaction,
} from "./solanaBurn.js";

/**
 * The two Solana transactions a user may need after a transfer, built by hand
 * like the burn: receive_message, which finishes a transfer to Solana that
 * Circle did not deliver, and reclaim_event_account, which returns the SOL a
 * burn from Solana parked in its event account. Layouts follow Circle's
 * solana-cctp-contracts V2 programs and v1's tested port; the tests check the
 * bytes against @solana/web3.js.
 */

const utf8 = (s: string) => new TextEncoder().encode(s);
const anchorDiscriminator = (name: string) => sha256(utf8(`global:${name}`)).slice(0, 8);
const ro = (pubkey: string): SolanaAccountMeta => ({ pubkey, isSigner: false, isWritable: false });
const rw = (pubkey: string): SolanaAccountMeta => ({ pubkey, isSigner: false, isWritable: true });
const mtPda = (...seeds: Uint8Array[]) => findProgramAddress(seeds, SOLANA_MESSAGE_TRANSMITTER_V2);
const tmmPda = (...seeds: Uint8Array[]) => findProgramAddress(seeds, SOLANA_TOKEN_MESSENGER_MINTER_V2);

export const RECEIVE_MESSAGE_DISCRIMINATOR = anchorDiscriminator("receive_message");
export const RECLAIM_EVENT_ACCOUNT_DISCRIMINATOR = anchorDiscriminator("reclaim_event_account");
/** Anchor's account discriminator for MessageTransmitterV2's MessageSent. */
export const MESSAGE_SENT_DISCRIMINATOR = sha256(utf8("account:MessageSent")).slice(0, 8);

/**
 * Circle's program refuses to close an event account younger than this, so
 * its off-chain service is sure to have read the message first.
 */
export const EVENT_ACCOUNT_REFUND_DELAY_SEC = 5 * 24 * 60 * 60;

export class SolanaClaimError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SolanaClaimError";
  }
}

/** Two Borsh Vec<u8> after the discriminator. */
function encodeTwoVecs(discriminator: Uint8Array, a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(8 + 4 + a.length + 4 + b.length);
  const v = new DataView(out.buffer);
  out.set(discriminator, 0);
  v.setUint32(8, a.length, true);
  out.set(a, 12);
  v.setUint32(12 + a.length, b.length, true);
  out.set(b, 16 + a.length);
  return out;
}

// ── Lookup tables ────────────────────────────────────────────────────────────

const LOOKUP_TABLE_PROGRAM = "AddressLookupTab1e1111111111111111111111111";
/** type u32, deactivation slot u64, last extended slot u64, start index u8, Option<authority>, padding. */
const LOOKUP_TABLE_META_BYTES = 56;
const NOT_DEACTIVATED = 0xffff_ffff_ffff_ffffn;

/** A live table's entries; null for anything else (missing, closed, deactivating, not a table). */
export function parseLookupTable(address: string, account: SolanaAccount | null): AddressLookupTable | null {
  if (!account || account.owner !== LOOKUP_TABLE_PROGRAM || account.data.length < LOOKUP_TABLE_META_BYTES) return null;
  const v = new DataView(account.data.buffer, account.data.byteOffset, account.data.byteLength);
  if (v.getUint32(0, true) !== 1 || v.getBigUint64(4, true) !== NOT_DEACTIVATED) return null;
  const addresses: string[] = [];
  for (let o = LOOKUP_TABLE_META_BYTES; o + 32 <= account.data.length; o += 32) {
    addresses.push(base58.encode(account.data.slice(o, o + 32)));
  }
  return { address, addresses };
}

// ── receive_message ──────────────────────────────────────────────────────────

/** TokenMessenger: discriminator, denylister, owner, pending owner, body version u32, bump u8, then fee_recipient. */
const FEE_RECIPIENT_OFFSET = 8 + 32 + 32 + 32 + 4 + 1;

/**
 * receive_message for a USDC transfer. The payer signs as both payer and
 * caller (fine while destinationCaller is zero or the payer) and pays the
 * nonce account's rent. TokenMessengerMinter's accounts follow as remaining
 * accounts, in the order of Circle's V2 example.
 */
export function receiveMessageInstruction(p: {
  payer: string;
  message: Hex;
  attestation: Hex;
  /** The mintRecipient: a USDC token account. */
  recipientTokenAccount: string;
  /** USDC account of TokenMessenger's fee_recipient, read from chain. */
  feeRecipientTokenAccount: string;
  mint: string;
}): SolanaInstruction {
  const header = decodeMessage(p.message);
  const body = decodeBurnMessage(header.body);
  const domain = utf8(String(header.sourceDomain));
  const mint = base58.decode(p.mint);
  const tmm = SOLANA_TOKEN_MESSENGER_MINTER_V2;
  const mt = SOLANA_MESSAGE_TRANSMITTER_V2;
  return {
    programId: mt,
    keys: [
      { pubkey: p.payer, isSigner: true, isWritable: true },
      { pubkey: p.payer, isSigner: true, isWritable: false }, // caller
      ro(mtPda(utf8("message_transmitter_authority"), base58.decode(tmm))),
      ro(mtPda(utf8("message_transmitter"))),
      rw(usedNonceAddress(header.nonce)),
      ro(tmm), // receiver
      ro(SYSTEM_PROGRAM),
      // #[event_cpi]
      ro(mtPda(utf8("__event_authority"))),
      ro(mt),
      // TokenMessengerMinter's handle_receive_finalized_message accounts.
      ro(tmmPda(utf8("token_messenger"))),
      ro(tmmPda(utf8("remote_token_messenger"), domain)),
      rw(tmmPda(utf8("token_minter"))),
      rw(tmmPda(utf8("local_token"), mint)),
      ro(tmmPda(utf8("token_pair"), domain, hexToBytes(body.burnToken))),
      rw(p.feeRecipientTokenAccount),
      rw(p.recipientTokenAccount),
      rw(tmmPda(utf8("custody"), mint)),
      ro(SPL_TOKEN_PROGRAM),
      ro(tmmPda(utf8("__event_authority"))),
      ro(tmm),
    ],
    data: encodeTwoVecs(RECEIVE_MESSAGE_DISCRIMINATOR, hexToBytes(p.message), hexToBytes(p.attestation)),
  };
}

/** The Associated Token program's CreateIdempotent: a no-op if the account already exists. */
export function createAssociatedTokenAccountInstruction(payer: string, owner: string, mint: string): SolanaInstruction {
  return {
    programId: ASSOCIATED_TOKEN_PROGRAM,
    keys: [
      { pubkey: payer, isSigner: true, isWritable: true },
      rw(associatedTokenAddress(owner, mint)),
      ro(owner),
      ro(mint),
      ro(SYSTEM_PROGRAM),
      ro(SPL_TOKEN_PROGRAM),
    ],
    data: new Uint8Array([1]),
  };
}

/** A transaction ready for the wallet: it needs only the payer's signature. */
export interface SolanaTxPlan {
  transaction: Uint8Array;
  lastValidBlockHeight: number;
  /** What the payer spends: fees plus any rent the transaction locks up. */
  costLamports: bigint;
}

export interface SolanaClaimPlan extends SolanaTxPlan {
  tokenAccount: string;
  /** The recipient had no USDC account, so this claim opens one (its rent is in the cost). */
  createsTokenAccount: boolean;
}

export interface BuildSolanaClaimOptions {
  chain: SolanaChain;
  /** Attested message and attestation, as Iris (or the bridge service) returns them. */
  message: Hex;
  attestation: Hex;
  /** Solana wallet that signs and pays. Anyone may, the recipient or not. */
  payer: string;
  /**
   * Wallets that may own the recipient's USDC account, tried when it does not
   * exist yet: the burn names only the account, and opening it needs its owner.
   */
  owners?: readonly string[];
  rpcUrls?: readonly string[];
  fetchImpl?: typeof fetch;
}

/**
 * Finishes a transfer to Solana that Circle did not deliver: the user's own
 * receive_message, simulated before it is offered for signing. Inline, the
 * transaction is ~1260 bytes (over Solana's limit), so it loads the fixed
 * accounts from the chain's lookup table.
 */
export async function buildSolanaClaim(opts: BuildSolanaClaimOptions): Promise<SolanaClaimPlan> {
  const { chain } = opts;
  const rpcUrls = opts.rpcUrls ?? chain.rpcUrls;
  const header = decodeMessage(opts.message);
  if (header.destinationDomain !== chain.domain) throw new SolanaClaimError(`This transfer is not bound for ${chain.name}`);
  if (header.recipient.toLowerCase() !== solanaToBytes32(SOLANA_TOKEN_MESSENGER_MINTER_V2)) {
    throw new SolanaClaimError("This message is not a USDC transfer");
  }
  const caller = header.destinationCaller.toLowerCase();
  if (caller !== ZERO_BYTES32 && caller !== solanaToBytes32(opts.payer)) {
    throw new SolanaClaimError(`Only ${bytes32ToSolana(header.destinationCaller as Hex)} can complete this transfer`);
  }
  const tokenAccount = bytes32ToSolana(decodeBurnMessage(header.body).mintRecipient);
  const account = (address: string) => solanaAccount(rpcUrls, address, opts.fetchImpl);

  const [nonce, recipient, messenger, table] = await Promise.all([
    account(usedNonceAddress(header.nonce)),
    account(tokenAccount),
    account(tmmPda(utf8("token_messenger"))),
    chain.receiveLookupTable ? account(chain.receiveLookupTable) : Promise.resolve(null),
  ]);
  if (nonce) throw new SolanaClaimError("This transfer was already delivered");
  if (!messenger || messenger.data.length < FEE_RECIPIENT_OFFSET + 32) {
    throw new SolanaClaimError("Could not read Circle's TokenMessenger account");
  }
  const feeRecipient = base58.encode(messenger.data.slice(FEE_RECIPIENT_OFFSET, FEE_RECIPIENT_OFFSET + 32));

  const instructions: SolanaInstruction[] = [];
  if (recipient) {
    if (parseTokenAccount(recipient)?.mint !== chain.usdcMint) {
      throw new SolanaClaimError(`${tokenAccount} is not a USDC account, so the program would refuse this mint`);
    }
  } else {
    const owner = (opts.owners ?? []).find((o) => associatedTokenAddress(o, chain.usdcMint) === tokenAccount);
    if (!owner) {
      throw new SolanaClaimError("The recipient has no USDC account on Solana yet. Connect the recipient's Solana wallet to open it and claim.");
    }
    instructions.push(createAssociatedTokenAccountInstruction(opts.payer, owner, chain.usdcMint));
  }
  instructions.push(
    receiveMessageInstruction({
      payer: opts.payer,
      message: opts.message,
      attestation: opts.attestation,
      recipientTokenAccount: tokenAccount,
      feeRecipientTokenAccount: associatedTokenAddress(feeRecipient, chain.usdcMint),
      mint: chain.usdcMint,
    }),
  );

  // The table's own entries decide what loads from it, so a stale or foreign
  // table can only leave accounts inline (and the size check refuse), never
  // point an index at a different account: tables are append-only.
  const lookup = chain.receiveLookupTable ? parseLookupTable(chain.receiveLookupTable, table) : null;
  const prepared = await prepareSolanaTransaction({
    rpcUrls,
    payer: opts.payer,
    instructions,
    priorityAccounts: [usedNonceAddress(header.nonce), tokenAccount, tmmPda(utf8("custody"), base58.decode(chain.usdcMint))],
    tables: lookup ? [lookup] : [],
    ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
  }).catch((e: unknown) => {
    if (!lookup && /byte limit/.test((e as Error).message)) {
      throw new SolanaClaimError("The claim needs Solana's lookup table, which could not be read. Try again in a moment.");
    }
    throw e;
  });

  const rent = (bytes: number, fallback: number) =>
    solanaRpc<number>(rpcUrls, "getMinimumBalanceForRentExemption", [bytes], opts.fetchImpl).catch(() => fallback);
  const [nonceRent, accountRent] = await Promise.all([rent(9, 953_520), recipient ? Promise.resolve(0) : rent(165, 2_039_280)]);

  return {
    transaction: serializeTransaction(prepared.message, new Map()),
    lastValidBlockHeight: prepared.lastValidBlockHeight,
    costLamports: prepared.feeLamports + BigInt(nonceRent) + BigInt(accountRent),
    tokenAccount,
    createsTokenAccount: !recipient,
  };
}

// ── reclaim_event_account ────────────────────────────────────────────────────

/** A burn's event account: who paid its rent, when, and the message it holds. */
export interface MessageSentAccount {
  address: string;
  rentPayer: string;
  /** Unix seconds. */
  createdAt: number;
  message: Hex;
  /** The refund. */
  lamports: number;
}

/** discriminator 8, rent_payer 32, created_at i64, Vec<u8> message. */
export function parseMessageSentAccount(address: string, account: SolanaAccount | null): MessageSentAccount | null {
  if (!account || account.owner !== SOLANA_MESSAGE_TRANSMITTER_V2 || account.data.length < 52) return null;
  if (!MESSAGE_SENT_DISCRIMINATOR.every((b, i) => account.data[i] === b)) return null;
  const v = new DataView(account.data.buffer, account.data.byteOffset, account.data.byteLength);
  const len = v.getUint32(48, true);
  if (account.data.length < 52 + len) return null;
  return {
    address,
    rentPayer: base58.encode(account.data.slice(8, 40)),
    createdAt: Number(v.getBigInt64(40, true)),
    message: bytesToHex(account.data.slice(52, 52 + len)),
    lamports: account.lamports,
  };
}

/** Event accounts by address, null where closed already. One RPC call per 100. */
export async function readMessageSentAccounts(
  rpcUrls: readonly string[],
  addresses: readonly string[],
  fetchImpl?: typeof fetch,
): Promise<Map<string, MessageSentAccount | null>> {
  const out = new Map<string, MessageSentAccount | null>();
  for (let i = 0; i < addresses.length; i += 100) {
    const chunk = addresses.slice(i, i + 100);
    const r = await solanaRpc<{ value: ({ owner: string; lamports: number; data: [string, string] } | null)[] }>(
      rpcUrls,
      "getMultipleAccounts",
      [chunk, { encoding: "base64", commitment: "confirmed" }],
      fetchImpl,
    );
    chunk.forEach((address, j) => {
      const a = r.value[j];
      out.set(address, a ? parseMessageSentAccount(address, { owner: a.owner, lamports: a.lamports, data: base64.decode(a.data[0]) }) : null);
    });
  }
  return out;
}

/** reclaim_event_account: the account's rent goes back to the payee, who must be its rent payer. */
export function reclaimEventAccountInstruction(p: { payee: string; eventAccount: string; message: Hex; attestation: Hex }): SolanaInstruction {
  return {
    programId: SOLANA_MESSAGE_TRANSMITTER_V2,
    keys: [{ pubkey: p.payee, isSigner: true, isWritable: true }, rw(mtPda(utf8("message_transmitter"))), rw(p.eventAccount)],
    data: encodeTwoVecs(RECLAIM_EVENT_ACCOUNT_DISCRIMINATOR, hexToBytes(p.attestation), hexToBytes(p.message)),
  };
}

export interface SolanaRefundPlan extends SolanaTxPlan {
  /** Lamports the account returns; the payer nets this minus costLamports. */
  refundLamports: bigint;
}

/**
 * Returns a burn's event-account rent to the wallet that paid it, once
 * Circle's 5-day window has passed. Needs the burn's attested message and
 * attestation (Iris's, for the burn's signature).
 */
export async function buildSolanaRefund(opts: {
  chain: SolanaChain;
  eventAccount: string;
  message: Hex;
  attestation: Hex;
  /** Must be the account's rent payer. */
  payee: string;
  rpcUrls?: readonly string[];
  fetchImpl?: typeof fetch;
  now?: () => number;
}): Promise<SolanaRefundPlan> {
  const rpcUrls = opts.rpcUrls ?? opts.chain.rpcUrls;
  const event = parseMessageSentAccount(opts.eventAccount, await solanaAccount(rpcUrls, opts.eventAccount, opts.fetchImpl));
  if (!event) throw new SolanaClaimError("This deposit was refunded already");
  if (event.rentPayer !== opts.payee) throw new SolanaClaimError(`Only ${event.rentPayer}, which paid the deposit, can take it back`);
  const due = event.createdAt + EVENT_ACCOUNT_REFUND_DELAY_SEC;
  if ((opts.now?.() ?? Date.now()) / 1000 < due) {
    throw new SolanaClaimError(`The deposit can be refunded from ${new Date(due * 1000).toUTCString()}`);
  }
  const prepared = await prepareSolanaTransaction({
    rpcUrls,
    payer: opts.payee,
    instructions: [reclaimEventAccountInstruction(opts)],
    priorityAccounts: [opts.eventAccount, mtPda(utf8("message_transmitter"))],
    ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
  });
  return {
    transaction: serializeTransaction(prepared.message, new Map()),
    lastValidBlockHeight: prepared.lastValidBlockHeight,
    costLamports: prepared.feeLamports,
    refundLamports: BigInt(event.lamports),
  };
}

import { ed25519 } from "@noble/curves/ed25519";
import { sha256 } from "@noble/hashes/sha2";
import { base58, base64 } from "@scure/base";
import { type Hex, bytesToHex, hexToBytes, size } from "viem";

/** CCTP V2 MessageTransmitter program (same id on mainnet and devnet). */
export const SOLANA_MESSAGE_TRANSMITTER_V2 = "CCTPV2Sm4AdWt5296sk4P66VBZ7bEhcARwFaaS9YPbeC";
/** CCTP V2 TokenMessengerMinter program, where burns start and mints land. */
export const SOLANA_TOKEN_MESSENGER_MINTER_V2 = "CCTPV2vPZJS2u2BBsUoscuikbYjnpFmbFsvVuJdgUMQe";
export const SPL_TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
export const ASSOCIATED_TOKEN_PROGRAM = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
export const SYSTEM_PROGRAM = "11111111111111111111111111111111";
export const COMPUTE_BUDGET_PROGRAM = "ComputeBudget111111111111111111111111111111";

const PDA_MARKER = new TextEncoder().encode("ProgramDerivedAddress");
const utf8 = (s: string) => new TextEncoder().encode(s);

function isOnCurve(bytes: Uint8Array): boolean {
  try {
    ed25519.ExtendedPoint.fromHex(bytes);
    return true;
  } catch {
    return false;
  }
}

/** Solana's findProgramAddress: highest bump whose hash is off the curve. */
export function findProgramAddress(seeds: Uint8Array[], programId: string): string {
  const program = base58.decode(programId);
  for (let bump = 255; bump >= 0; bump--) {
    const hash = sha256(
      new Uint8Array([...seeds.flatMap((s) => [...s]), bump, ...program, ...PDA_MARKER]),
    );
    if (!isOnCurve(hash)) return base58.encode(hash);
  }
  throw new Error("No viable program address");
}

/** A 32-byte base58 Solana address. Says nothing about what lives there. */
export function isSolanaAddress(input: string): boolean {
  try {
    return base58.decode(input.trim()).length === 32;
  } catch {
    return false;
  }
}

/**
 * True for an address a keypair can own: an ordinary wallet. Program-derived
 * addresses (associated token accounts among them) are off the curve.
 */
export function isWalletAddress(input: string): boolean {
  return isSolanaAddress(input) && isOnCurve(base58.decode(input.trim()));
}

export function solanaToBytes32(address: string): Hex {
  const bytes = base58.decode(address.trim());
  if (bytes.length !== 32) throw new Error(`${address} is not a Solana address`);
  return bytesToHex(bytes);
}

export function bytes32ToSolana(value: Hex): string {
  if (size(value) !== 32) throw new Error(`Expected bytes32, got ${size(value)} bytes`);
  return base58.encode(hexToBytes(value));
}

/**
 * The owner's associated token account for `mint`. CCTP mints to this, never
 * to the wallet itself: a burn naming the wallet as mintRecipient is unusable.
 */
export function associatedTokenAddress(owner: string, mint: string): string {
  return findProgramAddress(
    [base58.decode(owner), base58.decode(SPL_TOKEN_PROGRAM), base58.decode(mint)],
    ASSOCIATED_TOKEN_PROGRAM,
  );
}

/**
 * TokenMessengerMinter's record of a remote domain, keyed by the domain as a
 * decimal string. Every burn to that domain (and every mint from it) lists it,
 * which makes it a precise index of Solana burns bound for Injective.
 */
export function remoteTokenMessengerAddress(domain: number): string {
  return findProgramAddress([utf8("remote_token_messenger"), utf8(String(domain))], SOLANA_TOKEN_MESSENGER_MINTER_V2);
}

/**
 * On Solana a consumed CCTP V2 nonce is an account at
 * PDA(["used_nonce", nonce]) under the MessageTransmitter program; it exists
 * once the mint happened. There is no usedNonces view to call.
 */
export function usedNonceAddress(nonce: Hex): string {
  return findProgramAddress([utf8("used_nonce"), hexToBytes(nonce)], SOLANA_MESSAGE_TRANSMITTER_V2);
}

// ── JSON-RPC ─────────────────────────────────────────────────────────────────

export class SolanaRpcError extends Error {
  constructor(
    message: string,
    readonly code?: number,
  ) {
    super(message);
    this.name = "SolanaRpcError";
  }
}

/**
 * One JSON-RPC call over an ordered endpoint list. Transport failures move on
 * to the next URL; a JSON-RPC error is the node's answer and is thrown as is.
 */
export async function solanaRpc<T>(
  rpcUrls: readonly string[],
  method: string,
  params: unknown[],
  fetchImpl: typeof fetch = globalThis.fetch.bind(globalThis),
): Promise<T> {
  let lastError: unknown;
  for (const url of rpcUrls) {
    let body: { result?: T; error?: { message: string; code?: number } };
    try {
      const res = await fetchImpl(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      });
      if (!res.ok) throw new Error(`Solana RPC ${res.status}`);
      body = (await res.json()) as typeof body;
    } catch (e) {
      lastError = e;
      continue;
    }
    if (body.error) throw new SolanaRpcError(body.error.message, body.error.code);
    return body.result as T;
  }
  throw lastError ?? new Error("No Solana RPC configured");
}

export interface SolanaAccount {
  owner: string;
  lamports: number;
  data: Uint8Array;
}

export async function solanaAccount(
  rpcUrls: readonly string[],
  address: string,
  fetchImpl?: typeof fetch,
): Promise<SolanaAccount | null> {
  const r = await solanaRpc<{ value: { owner: string; lamports: number; data: [string, string] } | null }>(
    rpcUrls,
    "getAccountInfo",
    [address, { encoding: "base64", commitment: "confirmed" }],
    fetchImpl,
  );
  if (!r.value) return null;
  return { owner: r.value.owner, lamports: r.value.lamports, data: base64.decode(r.value.data[0]) };
}

export async function isSolanaNonceUsed(
  rpcUrls: readonly string[],
  nonce: Hex,
  fetchImpl?: typeof fetch,
): Promise<boolean> {
  return (await solanaAccount(rpcUrls, usedNonceAddress(nonce), fetchImpl)) !== null;
}

/** An SPL token account's mint and owner (bytes 0-32 and 32-64 of its data). */
export function parseTokenAccount(account: SolanaAccount): { mint: string; owner: string; amount: bigint } | null {
  if (account.owner !== SPL_TOKEN_PROGRAM || account.data.length < 72) return null;
  const amount = new DataView(account.data.buffer, account.data.byteOffset + 64, 8).getBigUint64(0, true);
  return { mint: base58.encode(account.data.slice(0, 32)), owner: base58.encode(account.data.slice(32, 64)), amount };
}

/** USDC held in the owner's associated token account; 0 when it does not exist yet. */
export async function solanaTokenBalance(
  rpcUrls: readonly string[],
  owner: string,
  mint: string,
  fetchImpl?: typeof fetch,
): Promise<bigint> {
  const account = await solanaAccount(rpcUrls, associatedTokenAddress(owner, mint), fetchImpl);
  return account ? (parseTokenAccount(account)?.amount ?? 0n) : 0n;
}

export async function solanaBalance(rpcUrls: readonly string[], address: string, fetchImpl?: typeof fetch): Promise<bigint> {
  const r = await solanaRpc<{ value: number }>(rpcUrls, "getBalance", [address, { commitment: "confirmed" }], fetchImpl);
  return BigInt(r.value);
}

/**
 * What a typed Solana recipient is, so a token account pasted where a wallet
 * belongs is caught before it becomes the owner of a new token account (and
 * the USDC is stranded).
 */
export type SolanaRecipientCheck =
  | { ok: true; tokenAccount: string; tokenAccountExists: boolean }
  | { ok: false; reason: "not_an_address" | "token_account" | "not_a_wallet" };

export async function checkSolanaRecipient(
  rpcUrls: readonly string[],
  owner: string,
  mint: string,
  fetchImpl?: typeof fetch,
): Promise<SolanaRecipientCheck> {
  if (!isSolanaAddress(owner)) return { ok: false, reason: "not_an_address" };
  const address = owner.trim();
  const [self, ata] = await Promise.all([
    solanaAccount(rpcUrls, address, fetchImpl),
    solanaAccount(rpcUrls, associatedTokenAddress(address, mint), fetchImpl),
  ]);
  if (self?.owner === SPL_TOKEN_PROGRAM) return { ok: false, reason: "token_account" };
  if (!isWalletAddress(address)) return { ok: false, reason: "not_a_wallet" };
  return { ok: true, tokenAccount: associatedTokenAddress(address, mint), tokenAccountExists: ata !== null };
}

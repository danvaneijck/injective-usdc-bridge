import { base58 } from "@scure/base";
import { toEvmAddress } from "../address.js";
import { isSolanaAddress } from "../solana.js";

export type LookupQuery = { kind: "tx"; tx: string } | { kind: "address"; address: string };

/**
 * What a pasted string is: a transaction (a 0x hash, the same without 0x, a
 * Solana signature) or a wallet (0x, inj1 or Solana). Null for neither.
 */
export function parseLookup(input: string): LookupQuery | null {
  const s = input.trim();
  if (/^(0x)?[0-9a-fA-F]{64}$/.test(s)) return { kind: "tx", tx: (s.startsWith("0x") ? s : `0x${s}`).toLowerCase() };
  const evm = toEvmAddress(s);
  if (evm) return { kind: "address", address: evm };
  if (isSolanaAddress(s)) return { kind: "address", address: s };
  try {
    if (base58.decode(s).length === 64) return { kind: "tx", tx: s };
  } catch {
    // Not base58.
  }
  return null;
}

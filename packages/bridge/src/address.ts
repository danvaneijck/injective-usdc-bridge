import { bech32 } from "@scure/base";
import { type Address, bytesToHex, getAddress, hexToBytes, isAddress } from "viem";

/**
 * An Injective account is one secp256k1 key with two spellings: the 0x
 * address MetaMask shows and the inj1 address Keplr shows, over the same 20
 * bytes. Either is accepted wherever an Injective recipient is asked for.
 */

/** 0x or inj1 to a checksummed 0x address; null when it is neither. */
export function toEvmAddress(input: string): Address | null {
  const s = input.trim();
  if (isAddress(s, { strict: false })) return getAddress(s);
  if (s.startsWith("inj1")) {
    try {
      const { prefix, bytes } = bech32.decodeToBytes(s as `${string}1${string}`);
      if (prefix === "inj" && bytes.length === 20) return getAddress(bytesToHex(bytes));
    } catch {
      return null;
    }
  }
  return null;
}

/** The inj1 spelling of a 0x address. */
export function toInjAddress(address: Address): string {
  return bech32.encode("inj", bech32.toWords(hexToBytes(address)));
}

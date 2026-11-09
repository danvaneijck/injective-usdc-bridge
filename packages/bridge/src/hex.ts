import { keccak_256 } from "@noble/hashes/sha3";

/**
 * Hex and EVM address helpers, so the core needs no viem. The types are the
 * same template-literal shapes as viem's `Hex` and `Address`, so values pass
 * between this package and viem unchanged. Everything here is checked against
 * viem in test/hex.test.ts.
 */

/** 0x-prefixed hex. */
export type Hex = `0x${string}`;
/** A 20-byte EVM address, 0x-prefixed (any case). */
export type Address = `0x${string}`;

const HEX = /^0x[0-9a-fA-F]*$/;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

export function isHex(value: unknown): value is Hex {
  return typeof value === "string" && HEX.test(value);
}

function assertHex(value: string): asserts value is Hex {
  if (!HEX.test(value) || value.length % 2 !== 0) throw new Error(`Not even-length hex: ${value}`);
}

/** Byte length. */
export function size(value: Hex): number {
  assertHex(value);
  return (value.length - 2) / 2;
}

/** Bytes [start, end) of `value`; out-of-range offsets throw. */
export function slice(value: Hex, start: number, end?: number): Hex {
  const n = size(value);
  const stop = end ?? n;
  if (start < 0 || stop > n || start > stop) {
    throw new Error(`Slice [${start}, ${stop}) is outside ${n} bytes`);
  }
  return `0x${value.slice(2 + start * 2, 2 + stop * 2)}`;
}

export function concat(parts: readonly Hex[]): Hex {
  for (const p of parts) assertHex(p);
  return `0x${parts.map((p) => p.slice(2)).join("")}`;
}

/** Left-pads to `bytes` (32 by default); longer values throw. */
export function pad(value: Hex, bytes = 32): Hex {
  const n = size(value);
  if (n > bytes) throw new Error(`${n} bytes do not fit in ${bytes}`);
  return `0x${value.slice(2).padStart(bytes * 2, "0")}`;
}

/** An unsigned integer as `bytes` big-endian bytes. */
export function numberToHex(value: number | bigint, bytes: number): Hex {
  const v = BigInt(value);
  if (v < 0n || v >= 1n << BigInt(bytes * 8)) throw new Error(`${value} does not fit in ${bytes} bytes`);
  return `0x${v.toString(16).padStart(bytes * 2, "0")}`;
}

/** UTF-8 bytes of `text`, right-padded with zeros to `bytes` when given. */
export function stringToHex(text: string, bytes?: number): Hex {
  const raw = bytesToHex(new TextEncoder().encode(text));
  if (bytes === undefined) return raw;
  if (size(raw) > bytes) throw new Error(`"${text}" does not fit in ${bytes} bytes`);
  return `0x${raw.slice(2).padEnd(bytes * 2, "0")}`;
}

export function hexToBigInt(value: Hex): bigint {
  assertHex(value);
  return value === "0x" ? 0n : BigInt(value);
}

export function hexToNumber(value: Hex): number {
  const v = hexToBigInt(value);
  if (v > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error(`${value} is too large for a number`);
  return Number(v);
}

export function bytesToHex(bytes: Uint8Array): Hex {
  let out = "0x";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out as Hex;
}

export function hexToBytes(value: Hex): Uint8Array {
  const n = size(value);
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = Number.parseInt(value.slice(2 + i * 2, 4 + i * 2), 16);
  return out;
}

export function keccak256(value: Hex): Hex {
  return bytesToHex(keccak_256(hexToBytes(value)));
}

/** EIP-55 mixed-case spelling of a 0x address of any case; throws otherwise. */
export function getAddress(value: string): Address {
  if (!ADDRESS.test(value)) throw new Error(`Address "${value}" is invalid`);
  const lower = value.slice(2).toLowerCase();
  const hash = bytesToHex(keccak_256(new TextEncoder().encode(lower))).slice(2);
  let out = "0x";
  for (let i = 0; i < 40; i++) out += Number.parseInt(hash[i]!, 16) >= 8 ? lower[i]!.toUpperCase() : lower[i]!;
  return out as Address;
}

/**
 * A 0x address. Strict (the default), as viem's `isAddress`: any spelling
 * with a capital letter must be its exact EIP-55 checksum; all-lowercase
 * carries no checksum and passes.
 */
export function isAddress(value: string, opts: { strict?: boolean } = {}): value is Address {
  if (!ADDRESS.test(value)) return false;
  if (opts.strict === false || value.slice(2) === value.slice(2).toLowerCase()) return true;
  return getAddress(value) === value;
}

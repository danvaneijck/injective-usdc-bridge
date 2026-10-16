import { type Hex, concat, pad, size, slice, stringToHex, toHex } from "viem";

const FORWARD_MAGIC = stringToHex("cctp-forward", { size: 24 });

/**
 * Circle Forwarding Service request, version 0 with no extra Circle data:
 * bytes 0-24 "cctp-forward", 24-28 version (0), 28-32 extra length (0).
 * Equals Circle's documented static value
 * 0x636374702d666f72776172640000000000000000000000000000000000000000.
 */
export const FORWARD_HOOK_DATA: Hex = concat([
  FORWARD_MAGIC,
  pad(toHex(0), { size: 4 }),
  pad(toHex(0), { size: 4 }),
]);

export function isForwardHookData(hookData: Hex): boolean {
  return size(hookData) >= 32 && slice(hookData, 0, 24).toLowerCase() === FORWARD_MAGIC;
}

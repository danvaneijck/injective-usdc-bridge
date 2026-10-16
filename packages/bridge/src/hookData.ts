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

/**
 * Forwarding to Solana for a recipient with no USDC account yet: version 0,
 * Circle data length 33, byte 32 = 1 (create the associated token account),
 * bytes 33-65 the owning wallet. Circle checks that mintRecipient is that
 * owner's USDC account, and the fee quoted with includeRecipientSetup=true
 * covers the rent. Without this, a burn to a missing account cannot land.
 */
export function forwardHookDataWithAccountSetup(owner: Hex): Hex {
  if (size(owner) !== 32) throw new Error("owner must be 32 bytes");
  return concat([FORWARD_MAGIC, pad(toHex(0), { size: 4 }), pad(toHex(33), { size: 4 }), "0x01", owner]);
}

/** The wallet named in an account-setup forwarding request, if this is one. */
export function forwardSetupOwner(hookData: Hex): Hex | null {
  if (!isForwardHookData(hookData) || size(hookData) < 65) return null;
  if (slice(hookData, 28, 32) !== pad(toHex(33), { size: 4 }) || slice(hookData, 32, 33) !== "0x01") return null;
  return slice(hookData, 33, 65);
}

import { formatUnits } from "viem";

/**
 * Gas for a send from an EVM chain: approve plus burn. Measured on Injective
 * 2026-10-17 (approve 55k, depositForBurn 484k, the heaviest of our chains);
 * elsewhere the burn costs less, so this errs high.
 */
export const SEND_GAS_UNITS = 600_000n;
/** A claim on the destination: receiveMessage, ~190k on Polygon (the heaviest outside Injective). */
export const CLAIM_GAS_UNITS = 250_000n;

/** Native token `units` of gas cost at `feePerGas`, with 20% headroom. */
export function gasNeed(feePerGas: bigint, units: bigint = SEND_GAS_UNITS): bigint {
  return (units * feePerGas * 12n) / 10n;
}

/** Tiny native amounts read as "0.000021", never "0" or "2.1e-5". */
export function formatGasAmount(wei: bigint, decimals = 18): string {
  return new Intl.NumberFormat("en-US", { maximumSignificantDigits: 2 }).format(Number(formatUnits(wei, decimals)));
}

/**
 * What to tell the sender before they sign, or null when the gas is there.
 * Short enough to sit under the button's label, which is where the form shows
 * it: one message where the eye already is, never a box beside a button that
 * says something else. Only a warning: a smart wallet with sponsored gas
 * sends with none.
 */
export function gasShort(
  gas: { balance: bigint; need: bigint } | null,
  symbol: string,
  chainName: string,
  action: "Sending" | "Claiming" = "Sending",
  decimals = 18,
): string | null {
  if (!gas || gas.balance >= gas.need) return null;
  const purpose = action === "Sending" ? "for gas" : "to claim with";
  const need = `needs ~${formatGasAmount(gas.need, decimals)}`;
  return gas.balance === 0n
    ? `No ${symbol} on ${chainName} ${purpose} (${need})`
    : `Low ${symbol} on ${chainName} ${purpose} (${need})`;
}

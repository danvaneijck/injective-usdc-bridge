import { formatUnits } from "viem";

/**
 * Gas for a send from an EVM chain: approve plus burn. Measured on Injective
 * 2026-10-17 (approve 55k, depositForBurn 484k, the heaviest of our chains);
 * elsewhere the burn costs less, so this errs high.
 */
export const SEND_GAS_UNITS = 600_000n;

/** Native token a send needs at `feePerGas`, with 20% headroom. */
export function gasNeed(feePerGas: bigint): bigint {
  return (SEND_GAS_UNITS * feePerGas * 12n) / 10n;
}

/** Tiny native amounts read as "0.000021", never "0" or "2.1e-5". */
export function formatGasAmount(wei: bigint): string {
  return new Intl.NumberFormat("en-US", { maximumSignificantDigits: 2 }).format(Number(formatUnits(wei, 18)));
}

/**
 * What to tell the sender before they sign, or null when the gas is there.
 * Only a warning: a smart wallet with sponsored gas sends with none.
 */
export function gasWarning(gas: { balance: bigint; need: bigint } | null, symbol: string, chainName: string): string | null {
  if (!gas || gas.balance >= gas.need) return null;
  const need = `about ${formatGasAmount(gas.need)} ${symbol}`;
  return gas.balance === 0n
    ? `This wallet has no ${symbol} on ${chainName} to pay for gas. Sending needs ${need}; add some first.`
    : `This wallet may not have enough ${symbol} on ${chainName} for gas: it has ${formatGasAmount(gas.balance)}, sending needs ${need}.`;
}

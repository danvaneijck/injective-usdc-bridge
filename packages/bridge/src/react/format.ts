import { formatUnits, parseUnits } from "viem";
import { USDC_DECIMALS } from "../constants.js";

/** "1,234.5" style, at most `max` decimals, trailing zeros dropped. */
export function formatAmount(value: bigint, decimals: number, max = 2): string {
  const s = formatUnits(value, decimals);
  const [whole = "0", frac = ""] = s.split(".");
  // A real amount below the shown precision ("0.001" at 2 decimals) shows its
  // first digits rather than reading as "0".
  const keep = whole === "0" && value > 0n && !/[1-9]/.test(frac.slice(0, max)) ? frac.search(/[1-9]/) + 2 : max;
  const cut = frac.slice(0, keep).replace(/0+$/, "");
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return cut ? `${grouped}.${cut}` : grouped;
}

/** Dollars read as dollars: "0.50", "643.43", "24.9961"; whole amounts stay "25". */
export function formatUsdc(value: bigint, max = 2): string {
  const s = formatAmount(value, USDC_DECIMALS, max);
  return /\.\d$/.test(s) ? `${s}0` : s;
}

/** A typed amount to base units; null while it is not a valid number yet. */
export function parseUsdc(input: string): bigint | null {
  const s = input.trim().replace(/,/g, "");
  if (!/^\d*\.?\d*$/.test(s) || s === "" || s === ".") return null;
  const [, frac = ""] = s.split(".");
  if (frac.length > USDC_DECIMALS) return null;
  try {
    return parseUnits(s, USDC_DECIMALS);
  } catch {
    return null;
  }
}

/** Keeps only what can become an amount as the user types. */
export function sanitizeAmountInput(input: string): string {
  const s = input.replace(/,/g, ".").replace(/[^\d.]/g, "");
  const [whole, ...rest] = s.split(".");
  return rest.length ? `${whole}.${rest.join("").slice(0, USDC_DECIMALS)}` : (whole ?? "");
}

export function shortAddress(a: string): string {
  return a.length > 14 ? `${a.slice(0, 6)}...${a.slice(-4)}` : a;
}

export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  if (h < 24) return m % 60 ? `${h} h ${m % 60} min` : `${h} h`;
  // Past a day minutes are noise: "1 day 5 h", then "7 days".
  const d = Math.floor(h / 24);
  if (d >= 2) return `${d} days`;
  return h % 24 ? `1 day ${h % 24} h` : "1 day";
}

/** When something happened, as coarse as a list row needs: "4 h ago", not "4 h 25 min ago". */
export function timeAgo(iso: string | null, now: number): string {
  if (!iso) return "";
  const ms = now - Date.parse(iso);
  if (ms < 60_000) return "just now";
  const m = Math.floor(ms / 60_000);
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.floor(h / 24);
  return d === 1 ? "yesterday" : `${d} days ago`;
}

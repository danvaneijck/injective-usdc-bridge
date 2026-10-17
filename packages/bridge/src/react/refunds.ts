import type { Hex } from "viem";
import type { SolanaChain } from "../chains.js";
import { EVENT_ACCOUNT_REFUND_DELAY_SEC, type MessageSentAccount, buildSolanaClaim, buildSolanaRefund } from "../solanaClaim.js";
import { isWalletAddress } from "../solana.js";
import type { TransferView } from "./api.js";
import type { Env } from "./hooks.js";
import { sendWithSolanaWallet } from "./solanaSend.js";
import type { SolanaWallet } from "./types.js";

/**
 * Where a burn from Solana's event-account deposit stands. `accounts` is the
 * on-chain read: a missing entry is not read yet, null is closed (refunded).
 */
export type RefundState =
  | { state: "unknown" }
  | { state: "refunded" }
  | { state: "waiting"; lamports: bigint; rentPayer: string; availableAt: number }
  | { state: "ready"; lamports: bigint; rentPayer: string };

export function refundState(v: TransferView, accounts: Map<string, MessageSentAccount | null> | null, now: number): RefundState | null {
  const r = v.solanaRefund;
  if (!r) return null;
  if (!accounts?.has(r.eventAccount)) return { state: "unknown" };
  const a = accounts.get(r.eventAccount);
  if (!a) return { state: "refunded" };
  const availableAt = (a.createdAt + EVENT_ACCOUNT_REFUND_DELAY_SEC) * 1000;
  const base = { lamports: BigInt(a.lamports), rentPayer: a.rentPayer };
  return now < availableAt ? { state: "waiting", ...base, availableAt } : { state: "ready", ...base };
}

export function solanaChainOf(env: Env): SolanaChain | undefined {
  return env.peerChains.find((c): c is SolanaChain => c.kind === "solana");
}

/** Takes one deposit back: build (simulated), sign, confirm. */
export async function reclaimDeposit(env: Env, wallet: SolanaWallet, v: TransferView): Promise<string> {
  const chain = solanaChainOf(env);
  const r = v.solanaRefund;
  if (!chain || !r) throw new Error("Nothing to reclaim on this transfer");
  const plan = await buildSolanaRefund({
    chain,
    eventAccount: r.eventAccount,
    message: r.message,
    attestation: r.attestation,
    payee: wallet.address,
    rpcUrls: env.solanaRpc,
  });
  return sendWithSolanaWallet(wallet, plan, env.solanaRpc);
}

/** Finishes a transfer to Solana from the connected Solana wallet, opening the USDC account if it has to. */
export async function claimOnSolana(env: Env, wallet: SolanaWallet, v: TransferView): Promise<string> {
  const chain = solanaChainOf(env);
  const c = v.solanaClaim;
  if (!chain || !c) throw new Error("This transfer cannot be completed from here");
  const plan = await buildSolanaClaim({
    chain,
    message: c.message,
    attestation: c.attestation,
    payer: wallet.address,
    owners: [v.recipient, wallet.address].filter((a): a is string => typeof a === "string" && isWalletAddress(a)),
    rpcUrls: env.solanaRpc,
  });
  return sendWithSolanaWallet(wallet, plan, env.solanaRpc);
}

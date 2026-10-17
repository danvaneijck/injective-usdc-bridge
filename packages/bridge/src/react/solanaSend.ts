import { base58 } from "@scure/base";
import { confirmSolanaSignature, submitSolanaTransaction, transactionSignature } from "../solanaBurn.js";
import type { SolanaWallet } from "./types.js";

/**
 * Has the wallet sign a prepared transaction and sees it land: the wallet
 * broadcasts when it can, otherwise the widget does (rebroadcasting until it
 * confirms or its blockhash expires). `onSigned` gets the signature the moment
 * it exists, before confirmation.
 */
export async function sendWithSolanaWallet(
  wallet: SolanaWallet,
  plan: { transaction: Uint8Array; lastValidBlockHeight: number },
  rpcUrls: readonly string[],
  onSigned?: (signature: string) => void,
): Promise<string> {
  if (wallet.signAndSendTransaction) {
    const sig = await wallet.signAndSendTransaction(plan.transaction);
    const signature = typeof sig === "string" ? sig : base58.encode(sig);
    onSigned?.(signature);
    await confirmSolanaSignature(rpcUrls, signature, plan.lastValidBlockHeight);
    return signature;
  }
  if (wallet.signTransaction) {
    const signed = await wallet.signTransaction(plan.transaction);
    const signature = transactionSignature(signed);
    onSigned?.(signature);
    await submitSolanaTransaction(rpcUrls, signed, plan.lastValidBlockHeight);
    return signature;
  }
  throw new Error("This Solana wallet cannot sign transactions.");
}

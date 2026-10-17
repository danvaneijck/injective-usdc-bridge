import { readFileSync } from "node:fs";
import { ed25519 } from "@noble/curves/ed25519";
import { base58 } from "@scure/base";

/**
 * A Solana keypair file (JSON array of 64 bytes: secret then public), read
 * in-process and never printed. Refuses a file whose halves do not match.
 */
export function readSolanaKey(path: string | undefined): { owner: string; sign: (wire: Uint8Array) => Uint8Array } {
  if (!path) throw new Error("Set SOL_KEY_FILE to a Solana keypair JSON file");
  const keypair = Uint8Array.from(JSON.parse(readFileSync(path, "utf8")) as number[]);
  if (keypair.length !== 64) throw new Error("SOL_KEY_FILE must hold 64 bytes");
  const secret = keypair.slice(0, 32);
  const owner = base58.encode(ed25519.getPublicKey(secret));
  if (owner !== base58.encode(keypair.slice(32))) throw new Error("SOL_KEY_FILE public half does not match its secret");
  return {
    owner,
    /** Fills the fee payer's (first) signature slot; the message follows all slots. */
    sign(wire) {
      const out = wire.slice();
      const message = out.slice(1 + 64 * out[0]!);
      out.set(ed25519.sign(message, secret), 1);
      return out;
    },
  };
}

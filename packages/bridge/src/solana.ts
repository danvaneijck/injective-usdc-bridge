import { ed25519 } from "@noble/curves/ed25519";
import { sha256 } from "@noble/hashes/sha2";
import { base58 } from "@scure/base";
import { type Hex, hexToBytes } from "viem";

/** CCTP V2 MessageTransmitter program (same id on mainnet and devnet). */
export const SOLANA_MESSAGE_TRANSMITTER_V2 = "CCTPV2Sm4AdWt5296sk4P66VBZ7bEhcARwFaaS9YPbeC";

const PDA_MARKER = new TextEncoder().encode("ProgramDerivedAddress");

function isOnCurve(bytes: Uint8Array): boolean {
  try {
    ed25519.ExtendedPoint.fromHex(bytes);
    return true;
  } catch {
    return false;
  }
}

/** Solana's findProgramAddress: highest bump whose hash is off the curve. */
export function findProgramAddress(seeds: Uint8Array[], programId: string): string {
  const program = base58.decode(programId);
  for (let bump = 255; bump >= 0; bump--) {
    const hash = sha256(
      new Uint8Array([...seeds.flatMap((s) => [...s]), bump, ...program, ...PDA_MARKER]),
    );
    if (!isOnCurve(hash)) return base58.encode(hash);
  }
  throw new Error("No viable program address");
}

/**
 * On Solana a consumed CCTP V2 nonce is an account at
 * PDA(["used_nonce", nonce]) under the MessageTransmitter program; it exists
 * once the mint happened. There is no usedNonces view to call.
 */
export function usedNonceAddress(nonce: Hex): string {
  return findProgramAddress(
    [new TextEncoder().encode("used_nonce"), hexToBytes(nonce)],
    SOLANA_MESSAGE_TRANSMITTER_V2,
  );
}

export async function isSolanaNonceUsed(
  rpcUrls: readonly string[],
  nonce: Hex,
  fetchImpl: typeof fetch = globalThis.fetch.bind(globalThis),
): Promise<boolean> {
  const address = usedNonceAddress(nonce);
  let lastError: unknown;
  for (const url of rpcUrls) {
    try {
      const res = await fetchImpl(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "getAccountInfo",
          params: [address, { encoding: "base64", commitment: "confirmed" }],
        }),
      });
      if (!res.ok) throw new Error(`Solana RPC ${res.status}`);
      const body = (await res.json()) as { result?: { value: unknown }; error?: { message: string } };
      // A JSON-RPC error is an answer from the node, not a transport failure.
      if (body.error) throw Object.assign(new Error(body.error.message), { final: true });
      return body.result?.value != null;
    } catch (e) {
      if ((e as { final?: boolean }).final) throw e;
      lastError = e;
    }
  }
  throw lastError ?? new Error("No Solana RPC configured");
}

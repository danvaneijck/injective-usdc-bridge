import { chainByDomain } from "./chains.js";
import { FINALITY, type Network } from "./constants.js";

/**
 * Chains whose Standard attestation waits for Ethereum finality (~13-19 min).
 * Elsewhere Standard is seconds to a couple of minutes.
 */
const L1_FINALITY = new Set(["ethereum", "base", "arbitrum", "optimism", "linea", "unichain", "worldchain", "ink"]);

/** How long Circle normally takes to attest a burn from this chain. */
export function expectedAttestMs(network: Network, srcDomain: number, minFinality: number): number {
  const chain = chainByDomain(network, srcDomain);
  if (minFinality <= FINALITY.fast && chain?.fastSource) return 30_000;
  if (chain && L1_FINALITY.has(chain.key)) return 20 * 60_000;
  return 2 * 60_000;
}

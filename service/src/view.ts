import { type Address, formatUnits } from "viem";
import { type Network, USDC_DECIMALS, chainByDomain, explorerTxUrl } from "injective-usdc-bridge";
import type { TransferRow } from "./db.js";
import { relayCallFor } from "./relayer.js";

const iso = (ms: number | null) => (ms ? new Date(ms).toISOString() : null);

/** Public JSON shape of a transfer. Amounts are USDC base units as strings. */
export function toView(row: TransferRow, network: Network, bridgeReceiver?: Address) {
  const src = chainByDomain(network, row.src_domain);
  const dst = chainByDomain(network, row.dst_domain);
  const mintTx = row.mint_tx ?? row.forward_tx;
  return {
    id: `${row.src_domain}:${row.tx_hash}:${row.log_index}`,
    direction: row.direction,
    kind: row.kind,
    phase: row.phase,
    amount: row.amount,
    amountUsdc: formatUnits(BigInt(row.amount), USDC_DECIMALS),
    maxFee: row.max_fee,
    feeExecuted: row.fee_executed,
    source: {
      domain: row.src_domain,
      chain: src?.key ?? null,
      name: src?.name ?? `domain ${row.src_domain}`,
      txHash: row.tx_hash,
      txUrl: src ? explorerTxUrl(src, row.tx_hash) : null,
      blockNumber: row.block_number,
      time: iso(row.block_time ? row.block_time * 1000 : row.first_seen),
    },
    destination: {
      domain: row.dst_domain,
      chain: dst?.key ?? null,
      name: dst?.name ?? `domain ${row.dst_domain}`,
      mintTx,
      mintTxUrl: dst && mintTx ? explorerTxUrl(dst, mintTx) : null,
    },
    depositor: row.depositor,
    recipient: row.recipient,
    mintRecipient: row.mint_recipient,
    mintedBy: row.minted_by,
    forwardState: row.forward_state,
    attestedAt: iso(row.attested_at),
    deliveredAt: iso(row.delivered_at),
    claim: claimFor(row, network, bridgeReceiver),
  };
}

/**
 * A ready-to-send call that completes the transfer, for a "Claim" button.
 * Offered for every attested, unminted transfer anyone may complete.
 */
function claimFor(row: TransferRow, network: Network, bridgeReceiver?: Address) {
  if (row.phase !== "ready" || !row.message || !row.attestation) return null;
  const dst = chainByDomain(network, row.dst_domain);
  if (!dst || dst.kind !== "evm") return null;
  const kind = row.kind === "forward" ? "plain" : row.kind;
  if (kind === "pinned_other") return null;
  if (kind === "gas_drop" && !bridgeReceiver) return null;
  const call = relayCallFor({ ...row, kind }, network, bridgeReceiver);
  return { chainId: dst.chainId, to: call.to, data: call.data };
}

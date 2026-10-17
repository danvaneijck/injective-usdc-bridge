/** Client for the bridge service's public API (service/src/api.ts). */
import type { Hex } from "viem";

export type Phase = "not_found" | "attesting" | "ready" | "expired" | "delivered";

export interface TransferView {
  id: string;
  direction: "deposit" | "withdraw";
  kind: "plain" | "forward" | "gas_drop" | "legacy_gas_drop" | "pinned_other";
  phase: Phase;
  /** USDC base units. */
  amount: string;
  amountUsdc: string;
  maxFee: string;
  feeExecuted: string | null;
  minFinality: number;
  expectedAttestSec: number;
  source: {
    domain: number;
    chain: string | null;
    name: string;
    txHash: string;
    txUrl: string | null;
    time: string | null;
  };
  destination: {
    domain: number;
    chain: string | null;
    name: string;
    mintTx: string | null;
    mintTxUrl: string | null;
  };
  depositor: string;
  /**
   * The wallet that receives. Null when the service does not know it, e.g. a
   * transfer to Solana names only a USDC account and its owner is unread.
   */
  recipient: string | null;
  /** The burn's mintRecipient, bytes32 hex: an EVM address, or a Solana USDC account. */
  mintRecipient: string;
  attestedAt: string | null;
  deliveredAt: string | null;
  /** A call anyone may send to finish an attested, unminted transfer. */
  claim: { chainId: number; to: string; data: string } | null;
  /** Transfers to Solana: what a Solana wallet needs to finish one itself. Absent from older services. */
  solanaClaim?: { message: Hex; attestation: Hex } | null;
  /** Transfers from Solana: the burn's event account, whose rent the depositor can take back from `availableAt`. */
  solanaRefund?: { eventAccount: string; message: Hex; attestation: Hex; availableAt: string } | null;
}

export interface LaneHealth {
  chain: string;
  domain: number;
  status: "ok" | "delayed" | "indexer_stalled" | "starting";
}

export class BridgeApi {
  private readonly base: string;

  constructor(base: string) {
    this.base = base.replace(/\/$/, "");
  }

  async transfers(address: string): Promise<TransferView[]> {
    const body = await this.get(`/v1/transfers?address=${encodeURIComponent(address)}&limit=50`);
    return (body as { transfers?: TransferView[] }).transfers ?? [];
  }

  /** The transfers in one source transaction; [] until it is mined and indexed. */
  async transfer(domain: number, txHash: string): Promise<TransferView[]> {
    const res = await fetch(`${this.base}/v1/transfers/${domain}/${txHash}`);
    if (res.status === 404) return [];
    if (!res.ok) throw new Error(`bridge api ${res.status}`);
    return ((await res.json()) as { transfers?: TransferView[] }).transfers ?? [];
  }

  /** Tells the service about a burn the moment it is signed. Best effort. */
  async hint(domain: number, txHash: string): Promise<void> {
    await fetch(`${this.base}/v1/transfers/hint`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sourceDomain: domain, txHash }),
    }).catch(() => undefined);
  }

  async lanes(): Promise<LaneHealth[]> {
    // 503 still carries the body: it means some lane is not ok.
    const res = await fetch(`${this.base}/v1/health`);
    const body = (await res.json().catch(() => ({}))) as { lanes?: LaneHealth[] };
    return body.lanes ?? [];
  }

  private async get(path: string): Promise<unknown> {
    const res = await fetch(`${this.base}${path}`);
    if (!res.ok) throw new Error(`bridge api ${res.status}`);
    return res.json();
  }
}

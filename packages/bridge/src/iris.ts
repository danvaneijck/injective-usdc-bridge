import type { Hex } from "viem";
import { IRIS_URLS, type Network } from "./constants.js";

/**
 * One message from GET /v2/messages/{sourceDomain}. While Iris is still
 * waiting for finality, `message` is "0x" and `attestation` is "PENDING".
 *
 * ⚠️ status "complete" means the attestation is SIGNED, not that the mint
 * happened. Only the destination chain's usedNonces can say that.
 */
export interface IrisMessage {
  message: Hex;
  eventNonce: Hex;
  attestation: Hex | "PENDING";
  cctpVersion: number;
  status: "complete" | "pending_confirmations" | (string & {});
  delayReason: string | null;
  decodedMessage?: {
    sourceDomain: string;
    destinationDomain: string;
    destinationCaller: Hex;
    decodedMessageBody?: {
      mintRecipient: Hex;
      amount: string;
      expirationBlock: string;
      hookData: Hex | null;
    } | null;
  } | null;
  /**
   * Present on burns that asked for Circle's Forwarding Service. Not in
   * Circle's docs; seen live 2026-10-16 as "CONFIRMED" with the destination
   * mint tx. A hint for display only: delivery is still decided by usedNonces.
   */
  forwardState?: string;
  forwardTxHash?: Hex;
  /** Anything else Iris adds. */
  [key: string]: unknown;
}

/** One finality tier from GET /v2/burn/USDC/fees/{src}/{dst}. */
export interface IrisFeeTier {
  finalityThreshold: number;
  /** Protocol fee in basis points; may be fractional (e.g. 1.3). */
  minimumFee: number;
  /** Forwarding fee in USDC base units; present only when asked with forward=true. */
  forwardFee?: { low: number; med: number; high: number };
}

export class IrisError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "IrisError";
  }
}

export interface IrisClientOptions {
  network?: Network;
  baseUrl?: string;
  fetch?: typeof fetch;
  /**
   * Circle's CDN 403s some default User-Agents (python-urllib). Sent only
   * outside browsers, which do not let pages set it.
   */
  userAgent?: string;
}

export class IrisClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly headers: Record<string, string>;

  constructor(opts: IrisClientOptions = {}) {
    this.baseUrl = (opts.baseUrl ?? IRIS_URLS[opts.network ?? "mainnet"]).replace(/\/$/, "");
    this.fetchImpl = opts.fetch ?? globalThis.fetch.bind(globalThis);
    this.headers = { accept: "application/json" };
    if (typeof window === "undefined") {
      this.headers["user-agent"] = opts.userAgent ?? "injective-usdc-bridge";
    }
  }

  /**
   * Messages emitted by a source transaction. Returns [] when Iris has not
   * indexed the tx yet; that alone does not mean the tx is invalid.
   */
  async getMessages(sourceDomain: number, txHash: Hex): Promise<IrisMessage[]> {
    const res = await this.request(
      `/v2/messages/${sourceDomain}?transactionHash=${txHash}`,
      { allowNotFound: true },
    );
    if (res === null) return [];
    const messages = (res as { messages?: IrisMessage[] }).messages;
    return Array.isArray(messages) ? messages : [];
  }

  async getFees(
    sourceDomain: number,
    destinationDomain: number,
    opts: { forward?: boolean } = {},
  ): Promise<IrisFeeTier[]> {
    const qs = opts.forward ? "?forward=true" : "";
    const res = await this.request(`/v2/burn/USDC/fees/${sourceDomain}/${destinationDomain}${qs}`);
    if (!Array.isArray(res)) throw new IrisError("Unexpected fee response", 200);
    return res as IrisFeeTier[];
  }

  /**
   * Ask Circle to re-sign a message whose expirationBlock has passed
   * ("Message expired and must be re-signed"). Re-fetch the message afterwards.
   */
  async reattest(nonce: Hex): Promise<void> {
    await this.request(`/v2/reattest/${nonce}`, { method: "POST" });
  }

  private async request(
    path: string,
    opts: { method?: string; allowNotFound?: boolean } = {},
  ): Promise<unknown> {
    const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method: opts.method ?? "GET",
      headers: this.headers,
    });
    if (res.status === 404 && opts.allowNotFound) return null;
    const text = await res.text();
    let body: unknown = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      // fall through with the raw text in the error
    }
    if (!res.ok) {
      const detail = (body as { error?: string; message?: string } | null)?.error
        ?? (body as { message?: string } | null)?.message
        ?? text.slice(0, 200);
      throw new IrisError(`Iris ${res.status} on ${path}: ${detail}`, res.status);
    }
    return body;
  }
}

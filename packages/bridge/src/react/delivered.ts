import type { TransferView } from "./api.js";

const txKey = (domain: number, txHash: string) => `${domain}:${txHash.toLowerCase()}`;

/**
 * Tells a host when a transfer lands, once. A transfer counts when it is seen
 * delivered after being seen on its way during this session, or when it was
 * sent from this widget (a fast one can be indexed already delivered). Older
 * transfers loaded already delivered, from Activity, never fire.
 */
export class DeliveryWatch {
  private readonly open = new Set<string>();
  private readonly fired = new Set<string>();
  private readonly sent = new Set<string>();

  markSent(domain: number, txHash: string): void {
    this.sent.add(txKey(domain, txHash));
  }

  /** Feed it every fresh list of views; returns the ones that just landed. */
  update(views: readonly TransferView[]): TransferView[] {
    const landed: TransferView[] = [];
    for (const v of views) {
      if (this.fired.has(v.id)) continue;
      if (v.phase !== "delivered") {
        this.open.add(v.id);
        continue;
      }
      if (this.open.has(v.id) || this.sent.has(txKey(v.source.domain, v.source.txHash))) {
        this.fired.add(v.id);
        landed.push(v);
      }
    }
    return landed;
  }
}

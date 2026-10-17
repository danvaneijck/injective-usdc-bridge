import { describe, expect, it } from "vitest";
import type { TransferView } from "../src/react/api.js";
import { formatUsdc, parseUsdc, sanitizeAmountInput } from "../src/react/format.js";
import { Journal } from "../src/react/journal.js";
import { CLAIM_AFTER_MS, progressOf } from "../src/react/progress.js";
import { refundState } from "../src/react/refunds.js";
import { toEvmAddress, toInjAddress } from "../src/address.js";

const T0 = Date.parse("2026-10-17T00:00:00Z");

function view(over: Partial<TransferView>): TransferView {
  return {
    id: "6:0xabc:0",
    direction: "deposit",
    kind: "plain",
    phase: "attesting",
    amount: "25000000",
    amountUsdc: "25",
    maxFee: "0",
    feeExecuted: null,
    minFinality: 2000,
    expectedAttestSec: 1200,
    source: { domain: 6, chain: "base", name: "Base", txHash: "0xabc", txUrl: "https://basescan.org/tx/0xabc", time: new Date(T0).toISOString() },
    destination: { domain: 29, chain: "injective", name: "Injective", mintTx: null, mintTxUrl: null },
    depositor: "0x1",
    recipient: "0x1",
    attestedAt: null,
    deliveredAt: null,
    claim: null,
    ...over,
  };
}

describe("progressOf", () => {
  it("counts down Circle's usual time, then says it is late", () => {
    const early = progressOf(view({}), T0 + 5 * 60_000);
    expect(early.headline).toBe("Waiting for Circle");
    expect(early.steps[1]).toMatchObject({ state: "active", detail: "Usually about 20 min, 15 min to go" });
    const late = progressOf(view({}), T0 + 40 * 60_000);
    expect(late.steps[1].detail).toBe("Taking longer than the usual 20 min");
    expect(late.steps.map((s) => s.state)).toEqual(["done", "active", "waiting"]);
  });

  it("offers to finish a stuck deposit only after a grace period", () => {
    const claim = { chainId: 1776, to: "0x2", data: "0x" };
    const ready = view({ phase: "ready", attestedAt: new Date(T0 + 60_000).toISOString(), claim });
    expect(progressOf(ready, T0 + 90_000)).toMatchObject({ headline: "Delivering", canClaim: false, tone: "progress" });
    expect(progressOf(ready, T0 + 60_000 + CLAIM_AFTER_MS + 1)).toMatchObject({ canClaim: true, tone: "attention" });
  });

  it("asks the user to claim a withdrawal Circle does not deliver, straight away", () => {
    const v = view({
      direction: "withdraw",
      kind: "plain",
      phase: "ready",
      attestedAt: new Date(T0).toISOString(),
      destination: { domain: 22, chain: "plasma", name: "Plasma", mintTx: null, mintTxUrl: null },
      claim: { chainId: 9745, to: "0x3", data: "0x" },
    });
    const p = progressOf(v, T0 + 1000);
    expect(p).toMatchObject({ headline: "Ready to claim", canClaim: true });
    expect(p.steps[2].detail).toBe("Ready for you to claim on Plasma");
  });

  it("reports delivery with the time it took and the mint link", () => {
    const v = view({
      phase: "delivered",
      deliveredAt: new Date(T0 + 18_000).toISOString(),
      destination: { domain: 29, chain: "injective", name: "Injective", mintTx: "0xm", mintTxUrl: "https://x/tx/0xm" },
    });
    const p = progressOf(v, T0 + 60_000);
    expect(p).toMatchObject({ headline: "Delivered", tone: "done", canClaim: false });
    expect(p.steps[2]).toMatchObject({ label: "Arrived on Injective", detail: "In 18 s", link: "https://x/tx/0xm" });
  });

  it("calls an expired approval what it is", () => {
    expect(progressOf(view({ phase: "expired" }), T0).steps[1].state).toBe("problem");
  });

  it("offers a Solana claim like any other: at once without Circle, after the grace period with it", () => {
    const toSolana = {
      direction: "withdraw" as const,
      phase: "ready" as const,
      attestedAt: new Date(T0).toISOString(),
      destination: { domain: 5, chain: "solana", name: "Solana", mintTx: null, mintTxUrl: null },
      solanaClaim: { message: "0x01" as const, attestation: "0x02" as const },
    };
    expect(progressOf(view({ ...toSolana, kind: "plain" }), T0 + 1000)).toMatchObject({ headline: "Ready to claim", canClaim: true });
    expect(progressOf(view({ ...toSolana, kind: "forward" }), T0 + 1000).canClaim).toBe(false);
    expect(progressOf(view({ ...toSolana, kind: "forward" }), T0 + CLAIM_AFTER_MS + 1).canClaim).toBe(true);
    // An older service sends no solanaClaim: nothing to offer.
    expect(progressOf(view({ ...toSolana, kind: "plain", solanaClaim: undefined }), T0 + 1000).canClaim).toBe(false);
  });
});

describe("refundState", () => {
  const refund = { eventAccount: "Ev", message: "0x01" as const, attestation: "0x02" as const, availableAt: new Date(T0).toISOString() };
  const account = (createdAt: number) => ({ address: "Ev", rentPayer: "Payer", createdAt, message: "0x01" as const, lamports: 2_824_480 });
  const created = T0 / 1000;

  it("follows the event account on chain: not read, waiting out Circle's 5 days, ready, closed", () => {
    const v = view({ solanaRefund: refund });
    expect(refundState(view({}), new Map(), T0)).toBeNull();
    expect(refundState(v, null, T0)).toEqual({ state: "unknown" });
    const accounts = new Map([["Ev", account(created)]]);
    expect(refundState(v, accounts, T0 + 3_600_000)).toEqual({ state: "waiting", lamports: 2_824_480n, rentPayer: "Payer", availableAt: T0 + 5 * 86_400_000 });
    expect(refundState(v, accounts, T0 + 5 * 86_400_000)).toEqual({ state: "ready", lamports: 2_824_480n, rentPayer: "Payer" });
    expect(refundState(v, new Map([["Ev", null]]), T0)).toEqual({ state: "refunded" });
  });
});

describe("Journal", () => {
  function memory() {
    const m = new Map<string, string>();
    return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
  }

  it("keeps every burn, newest first, without duplicates", () => {
    const j = new Journal(memory());
    j.add({ domain: 6, txHash: "0xa", address: "0x1", at: T0 });
    j.add({ domain: 3, txHash: "0xb", address: "0x1", at: T0 + 1 });
    j.add({ domain: 6, txHash: "0xA", address: "0x1", at: T0 + 2 });
    expect(j.list(T0 + 3).map((e) => e.txHash)).toEqual(["0xA", "0xb"]);
    expect(j.forAddress("0x2", T0 + 3)).toEqual([]);
  });

  it("still remembers this session when storage refuses writes", () => {
    const j = new Journal({ getItem: () => null, setItem: () => { throw new Error("quota"); } });
    j.add({ domain: 6, txHash: "0xa", address: "0x1", at: T0 });
    expect(j.list(T0)).toHaveLength(1);
  });
});

describe("amounts and addresses", () => {
  it("parses only what can be sent", () => {
    expect(parseUsdc("25")).toBe(25_000_000n);
    expect(parseUsdc("0.000001")).toBe(1n);
    expect(parseUsdc("0.0000001")).toBeNull();
    expect(parseUsdc("1,000.5")).toBe(1_000_500_000n);
    expect(parseUsdc(".")).toBeNull();
    expect(sanitizeAmountInput("12,5abc")).toBe("12.5");
  });

  it("reads like money", () => {
    expect(formatUsdc(500_000n)).toBe("0.50");
    expect(formatUsdc(25_000_000n)).toBe("25");
    expect(formatUsdc(643_430_000n)).toBe("643.43");
    expect(formatUsdc(1_234_567_890n, 6)).toBe("1,234.56789");
  });

  it("round-trips an Injective address between its spellings", () => {
    const a = "0x2f556c5fd6dbf782d9e483983c39a9871aa24e82";
    const inj = toInjAddress(toEvmAddress(a)!);
    expect(inj.startsWith("inj1")).toBe(true);
    expect(toEvmAddress(inj)?.toLowerCase()).toBe(a);
    expect(toEvmAddress("inj1notanaddress")).toBeNull();
  });
});

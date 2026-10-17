import { describe, expect, it } from "vitest";
import type { TransferView } from "../src/react/api.js";
import { landingMessage, stageOf, titleStatus } from "../src/react/alerts.js";
import { sortByBalance } from "../src/react/ChainPicker.js";
import { formatDuration, formatUsdc, parseUsdc, sanitizeAmountInput, timeAgo } from "../src/react/format.js";
import { richestChain } from "../src/react/hooks.js";
import { parseLookup } from "../src/react/lookup.js";
import { formatGasAmount, gasNeed, gasWarning } from "../src/react/gas.js";
import { Journal } from "../src/react/journal.js";
import { CLAIM_AFTER_MS, progressOf } from "../src/react/progress.js";
import { refundState } from "../src/react/refunds.js";
import { feeLine, receiverOf } from "../src/react/TransferStatus.js";
import { peers } from "../src/chains.js";
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
    mintRecipient: `0x${"00".repeat(31)}01`,
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

describe("durations and gas", () => {
  it("reads long waits in days", () => {
    expect(formatDuration(18_000)).toBe("18 s");
    expect(formatDuration(173 * 3_600_000 + 12 * 60_000)).toBe("7 days");
    expect(formatDuration(29 * 3_600_000)).toBe("1 day 5 h");
    expect(formatDuration(24 * 3_600_000)).toBe("1 day");
    expect(formatDuration(5 * 3_600_000 + 60_000)).toBe("5 h 1 min");
  });

  it("says how long ago at a list's grain", () => {
    const at = (ms: number) => timeAgo(new Date(T0).toISOString(), T0 + ms);
    expect(at(20_000)).toBe("just now");
    expect(at(14 * 60_000 + 50_000)).toBe("14 min ago");
    expect(at(4 * 3_600_000 + 25 * 60_000)).toBe("4 h ago");
    expect(at(30 * 3_600_000)).toBe("yesterday");
    expect(at(173 * 3_600_000)).toBe("7 days ago");
    expect(timeAgo(null, T0)).toBe("");
  });

  it("warns before signing when the source chain's gas is missing or short", () => {
    const need = gasNeed(1_180_000_000n); // Injective's pinned fee
    expect(formatGasAmount(need)).toBe("0.00085");
    expect(gasWarning({ balance: 0n, need }, "INJ", "Injective")).toBe(
      "This wallet has no INJ on Injective to pay for gas. Sending needs about 0.00085 INJ; add some first.",
    );
    expect(gasWarning({ balance: need / 2n, need }, "ETH", "Base")).toMatch(/^This wallet may not have enough ETH on Base for gas: it has 0.00042/);
    expect(gasWarning({ balance: need, need }, "ETH", "Base")).toBeNull();
    expect(gasWarning(null, "ETH", "Base")).toBeNull();
    expect(formatGasAmount(1_920_000_000_000n)).toBe("0.0000019");
  });

  it("words a claim's gas, in SOL's 9 decimals on Solana", () => {
    expect(gasWarning({ balance: 0n, need: 1_000_000n }, "SOL", "Solana", "Claiming", 9)).toBe(
      "This wallet has no SOL on Solana to pay for gas. Claiming needs about 0.001 SOL; add some first.",
    );
    expect(gasWarning({ balance: 400_000n, need: 1_000_000n }, "SOL", "Solana", "Claiming", 9)).toBe(
      "This wallet may not have enough SOL on Solana for gas: it has 0.0004, claiming needs about 0.001 SOL.",
    );
  });
});

describe("receiverOf", () => {
  const toSolana = { domain: 5, chain: "solana", name: "Solana", mintTx: null, mintTxUrl: null };
  // A real burn's mintRecipient: the USDC account AmEb5n..., owned by LoiT4g...
  const ata = "0x910e19fd124b7d3ce8d6aa3c6694b388ba311c7a0e12f1391fa310fc01e2c07b";

  it("shows the wallet, else the Solana USDC account, else nothing", () => {
    expect(receiverOf(view({ recipient: "0xabc" }))).toEqual({ label: "Recipient", address: "0xabc" });
    expect(receiverOf(view({ recipient: null, mintRecipient: ata, destination: toSolana }))).toEqual({
      label: "USDC account",
      address: "AmEb5nWjkqM9m1BJWish85xkNtXeQ57KHA62bZQjRLgz",
    });
    expect(receiverOf(view({ recipient: null }))).toBeNull();
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

describe("feeLine", () => {
  it("names the fee as the form did: Circle's fee, the delivery, or both", () => {
    expect(feeLine(view({ feeExecuted: "0" }))).toBeNull();
    expect(feeLine(view({ feeExecuted: "2500", minFinality: 1000 }))).toEqual({ label: "Circle fee", value: "0.0025 USDC" });
    // From Injective (standard finality) Circle's fee is nil: it is all delivery.
    expect(feeLine(view({ kind: "forward", feeExecuted: "281261" }))).toEqual({ label: "Delivery", value: "0.281261 USDC, by Circle" });
    expect(feeLine(view({ kind: "forward", feeExecuted: "90000", minFinality: 1000 }))).toEqual({
      label: "Fees",
      value: "0.09 USDC, Circle fee and delivery",
    });
  });
});

describe("chain balances", () => {
  const chains = peers("mainnet");
  const keys = (list: { key: string }[]) => list.map((c) => c.key);

  it("lists chains holding USDC first, most first, the rest in the usual order", () => {
    const held = new Map([
      ["arbitrum", 5_000_000n],
      ["polygon", 90_000_000n],
    ]);
    const sorted = sortByBalance(chains, (c) => held.get(c.key) ?? 0n);
    expect(keys(sorted).slice(0, 4)).toEqual(["polygon", "arbitrum", "solana", "hyperevm"]);
    expect(sorted).toHaveLength(chains.length);
  });

  it("starts where the USDC is, unless the current chain holds some", () => {
    const held = new Map([
      ["base", 0n],
      ["arbitrum", 5_000_000n],
      ["solana", 9_000_000n],
    ]);
    expect(richestChain(held, "base")).toBe("solana");
    expect(richestChain(new Map([...held, ["base", 1n]]), "base")).toBeNull();
    expect(richestChain(new Map([["base", 0n]]), "base")).toBeNull();
  });
});

describe("parseLookup", () => {
  it("tells transactions from wallets, whichever chain they are on", () => {
    const hash = "0xF45A2B21" + "ab".repeat(28);
    expect(parseLookup(` ${hash} `)).toEqual({ kind: "tx", tx: hash.toLowerCase() });
    expect(parseLookup(hash.slice(2))).toEqual({ kind: "tx", tx: hash.toLowerCase() });
    const sig = "4Um9oKSeCbY7LkqK496dMZe3tHFC4oVsfupLVDzL85L4RGsZdMjjvbESAPhCEwgZVV1ndAXDvmFVNMKvEDS7KCUL";
    expect(parseLookup(sig)).toEqual({ kind: "tx", tx: sig });
    expect(parseLookup("0x7516e4d49976f6485a9bf03fac841abf0369e4f6")).toEqual({ kind: "address", address: "0x7516E4D49976f6485A9BF03fac841AbF0369E4f6" });
    expect(parseLookup("inj1w5twf4yewmmysk5m7ql6epq6hupkne8kq7j9a0")).toEqual({ kind: "address", address: "0x7516E4D49976f6485A9BF03fac841AbF0369E4f6" });
    expect(parseLookup("9BcP3QkBxh1ZrEWLAcVTJ2asXgHuocdG56bvGTEUREho")).toEqual({ kind: "address", address: "9BcP3QkBxh1ZrEWLAcVTJ2asXgHuocdG56bvGTEUREho" });
    expect(parseLookup("hello")).toBeNull();
    expect(parseLookup("")).toBeNull();
  });
});

describe("alerts", () => {
  it("puts the wait in the tab title while something is on its way", () => {
    expect(titleStatus([], 0, T0)).toBeNull();
    expect(titleStatus([view({ phase: "delivered" })], 0, T0)).toBeNull();
    expect(titleStatus([], 1, T0)).toBe("Confirming");
    expect(titleStatus([view({})], 0, T0 + 8 * 60_000)).toBe("12 min left");
    expect(titleStatus([view({})], 0, T0 + 19 * 60_000 + 30_000)).toBe("Waiting for Circle");
    expect(titleStatus([view({ phase: "ready", attestedAt: new Date(T0).toISOString() })], 0, T0)).toBe("Delivering");
    expect(titleStatus([view({}), view({ id: "b" })], 1, T0)).toBe("3 transfers on the way");
  });

  it("announces a landing, or a withdrawal waiting for its owner's claim", () => {
    expect(stageOf(view({}))).toBe("moving");
    expect(stageOf(view({ phase: "ready" }))).toBe("moving");
    expect(stageOf(view({ phase: "delivered" }))).toBe("landed");
    const withdrawal = { direction: "withdraw" as const, destination: { domain: 3, chain: "arbitrum", name: "Arbitrum", mintTx: null, mintTxUrl: null } };
    expect(stageOf(view({ ...withdrawal, phase: "ready" }))).toBe("claim");
    expect(stageOf(view({ ...withdrawal, kind: "forward", phase: "ready" }))).toBe("moving");
    expect(landingMessage(view({ phase: "delivered" }), "landed")).toEqual({
      title: "25 USDC arrived on Injective",
      body: "Your transfer from Base was delivered.",
    });
    expect(landingMessage(view({ ...withdrawal, phase: "ready" }), "claim").title).toBe("25 USDC is ready to claim on Arbitrum");
  });
});

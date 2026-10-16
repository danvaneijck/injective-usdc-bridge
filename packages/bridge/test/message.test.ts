import { encodeEventTopics, getAddress } from "viem";
import { describe, expect, it } from "vitest";
import { tokenMessengerV2Abi } from "../src/abis.js";
import { FORWARD_HOOK_DATA, isForwardHookData } from "../src/hookData.js";
import {
  addressToBytes32,
  bytes32ToAddress,
  decodeBurnMessage,
  decodeMessage,
  isPermissionless,
} from "../src/message.js";
import { INJ_TO_BASE_MESSAGE, INJ_TO_BASE_NONCE } from "./fixtures.js";

describe("decodeMessage", () => {
  it("decodes a real Injective -> Base message", () => {
    const m = decodeMessage(INJ_TO_BASE_MESSAGE);
    expect(m.version).toBe(1);
    expect(m.sourceDomain).toBe(29);
    expect(m.destinationDomain).toBe(6);
    expect(m.nonce).toBe(INJ_TO_BASE_NONCE);
    expect(m.minFinalityThreshold).toBe(1000);
    expect(m.finalityThresholdExecuted).toBe(2000);
    expect(isPermissionless(m)).toBe(true);
    expect(bytes32ToAddress(m.sender)).toBe(
      getAddress("0x28b5a0e9c621a5badaa536219b3a228c8168cf5d"),
    );

    const b = decodeBurnMessage(m.body);
    expect(b.version).toBe(1);
    expect(bytes32ToAddress(b.burnToken)).toBe(
      getAddress("0xa00c59ff5a080d2b954d0c75e46e22a0c371235a"),
    );
    expect(bytes32ToAddress(b.mintRecipient)).toBe(
      getAddress("0x73fcb2d05f2e29561b58177af7f22ac19b3b484f"),
    );
    expect(b.amount).toBe(227_118_876n);
    expect(b.maxFee).toBe(0n);
    expect(b.expirationBlock).toBe(0n);
    expect(b.hookData).toBe("0x");
  });

  it("rejects truncated input", () => {
    expect(() => decodeMessage("0x0000")).toThrow(/too short/);
    expect(() => decodeBurnMessage("0x0000")).toThrow(/too short/);
  });
});

describe("bytes32 helpers", () => {
  it("round-trips an address", () => {
    const a = getAddress("0x73fcb2d05f2e29561b58177af7f22ac19b3b484f");
    expect(bytes32ToAddress(addressToBytes32(a))).toBe(a);
  });

  it("refuses a non-address bytes32 (e.g. a Solana key)", () => {
    expect(() =>
      bytes32ToAddress("0xc6fa7af3bedbad3a3d65f36aabc97431b1bbe4c2d2f6e0e47ca60203452f5d61"),
    ).toThrow(/not an EVM address/);
  });
});

describe("forwarding hook data", () => {
  it("matches Circle's documented static value", () => {
    expect(FORWARD_HOOK_DATA).toBe(
      "0x636374702d666f72776172640000000000000000000000000000000000000000",
    );
    expect(isForwardHookData(FORWARD_HOOK_DATA)).toBe(true);
    expect(isForwardHookData("0x")).toBe(false);
  });
});

describe("abis", () => {
  it("DepositForBurn topic0 matches the one the rescue sweeps used", () => {
    const [topic0] = encodeEventTopics({ abi: tokenMessengerV2Abi, eventName: "DepositForBurn" });
    expect(topic0).toBe("0x0c8c1cbdc5190613ebd485511d4e2812cfa45eecb79d845893331fedad5130a5");
  });
});

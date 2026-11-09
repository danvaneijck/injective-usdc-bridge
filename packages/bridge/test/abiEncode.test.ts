// The core's own hex, address and ABI helpers against viem, which the core no
// longer imports (viem stays a dev dependency for exactly this).
import * as viem from "viem";
import { describe, expect, it } from "vitest";
import { encodeArgs, selector } from "../src/abiEncode.js";
import { erc20Abi, messageTransmitterV2Abi, tokenMessengerV2Abi } from "../src/abis.js";
import { approveCalldata, burnCall } from "../src/burn.js";
import { CCTP_CONTRACTS } from "../src/constants.js";
import { bridgeReceiverAbi, encodeGasDropHook } from "../src/gasDrop.js";
import * as hex from "../src/hex.js";
import { FORWARD_HOOK_DATA, forwardHookDataWithAccountSetup } from "../src/hookData.js";

/** Deterministic bytes, so failures reproduce. */
function bytes(n: number, seed: number): viem.Hex {
  let x = seed >>> 0 || 1;
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    out[i] = x & 0xff;
  }
  return viem.bytesToHex(out);
}

const addresses = Array.from({ length: 40 }, (_, i) => bytes(20, i + 1));

describe("hex helpers match viem", () => {
  it("checksums addresses (EIP-55) and judges them as viem does", () => {
    for (const a of addresses) {
      const want = viem.getAddress(a);
      expect(hex.getAddress(a)).toBe(want);
      expect(hex.getAddress(a.toUpperCase().replace("0X", "0x"))).toBe(want);
      for (const s of [a, want, a.toUpperCase().replace("0X", "0x"), want.slice(0, 5) + want.slice(5).replace(/[a-f]/, (c) => c.toUpperCase())]) {
        expect(hex.isAddress(s), s).toBe(viem.isAddress(s));
        expect(hex.isAddress(s, { strict: false }), s).toBe(viem.isAddress(s, { strict: false }));
      }
    }
    for (const bad of ["0x", "0x123", `0x${"g".repeat(40)}`, "abcd".repeat(10), `0x${"a".repeat(41)}`]) {
      expect(hex.isAddress(bad)).toBe(false);
      expect(() => hex.getAddress(bad)).toThrow();
    }
  });

  it("slices, pads, concatenates and converts", () => {
    const v = bytes(100, 7);
    for (const [s, e] of [[0, 4], [4, 36], [36, 100], [99, 100], [0, 100]] as const) {
      expect(hex.slice(v, s, e)).toBe(viem.slice(v, s, e));
    }
    expect(hex.slice(v, 50)).toBe(viem.slice(v, 50));
    expect(() => hex.slice(v, 90, 101)).toThrow();
    expect(hex.size(v)).toBe(viem.size(v));
    expect(hex.pad("0xabcd", 32)).toBe(viem.pad("0xabcd", { size: 32 }));
    expect(hex.pad("0xabcd", 4)).toBe(viem.pad("0xabcd", { size: 4 }));
    expect(hex.concat([v, "0x", "0x01"])).toBe(viem.concat([v, "0x", "0x01"]));
    expect(hex.numberToHex(33, 4)).toBe(viem.pad(viem.toHex(33), { size: 4 }));
    expect(hex.numberToHex(2n ** 255n, 32)).toBe(viem.numberToHex(2n ** 255n, { size: 32 }));
    expect(() => hex.numberToHex(256, 1)).toThrow();
    expect(hex.stringToHex("cctp-forward", 24)).toBe(viem.stringToHex("cctp-forward", { size: 24 }));
    expect(hex.hexToBigInt(v)).toBe(viem.hexToBigInt(v));
    expect(hex.hexToNumber("0x00000064")).toBe(viem.hexToNumber("0x00000064"));
    expect(hex.bytesToHex(viem.hexToBytes(v))).toBe(v);
    expect(viem.bytesToHex(hex.hexToBytes(v))).toBe(v);
    expect(hex.keccak256(v)).toBe(viem.keccak256(v));
  });
});

describe("ABIs and calldata match viem", () => {
  it("holds the ABIs parseAbi made of the signatures", () => {
    expect(tokenMessengerV2Abi).toEqual(
      viem.parseAbi([
        "function depositForBurn(uint256 amount, uint32 destinationDomain, bytes32 mintRecipient, address burnToken, bytes32 destinationCaller, uint256 maxFee, uint32 minFinalityThreshold)",
        "function depositForBurnWithHook(uint256 amount, uint32 destinationDomain, bytes32 mintRecipient, address burnToken, bytes32 destinationCaller, uint256 maxFee, uint32 minFinalityThreshold, bytes hookData)",
        "event DepositForBurn(address indexed burnToken, uint256 amount, address indexed depositor, bytes32 mintRecipient, uint32 destinationDomain, bytes32 destinationTokenMessenger, bytes32 destinationCaller, uint256 maxFee, uint32 indexed minFinalityThreshold, bytes hookData)",
      ]),
    );
    expect(messageTransmitterV2Abi).toEqual(
      viem.parseAbi([
        "function receiveMessage(bytes message, bytes attestation) returns (bool)",
        "function usedNonces(bytes32 nonce) view returns (uint256)",
        "function localDomain() view returns (uint32)",
        "event MessageSent(bytes message)",
        "event MessageReceived(address indexed caller, uint32 sourceDomain, bytes32 indexed nonce, bytes32 sender, uint32 indexed finalityThresholdExecuted, bytes messageBody)",
      ]),
    );
    expect(erc20Abi).toEqual(
      viem.parseAbi([
        "function balanceOf(address owner) view returns (uint256)",
        "function allowance(address owner, address spender) view returns (uint256)",
        "function approve(address spender, uint256 amount) returns (bool)",
        "function decimals() view returns (uint8)",
        "function symbol() view returns (string)",
      ]),
    );
    expect(bridgeReceiverAbi).toEqual(
      viem.parseAbi([
        "function relay(bytes message, bytes attestation)",
        "function dropWei() view returns (uint256)",
        "function dropFee() view returns (uint256)",
        "function dropsPaused() view returns (bool)",
        "function feeBps() view returns (uint256)",
        "function claim(address to)",
        "function escrow(bytes32 account) view returns (uint256)",
        "function accruedFees() view returns (uint256)",
        "function sweepFees(uint256 amount, address to)",
        "event Relayed(bytes32 indexed nonce, address indexed recipient, uint256 minted, uint256 usdcPaid, uint256 dropFeeCharged, uint256 injDropped, uint256 bridgeFeeCharged)",
        "event DropSkipped(bytes32 indexed nonce, address indexed recipient, uint8 reason)",
      ]),
    );
  });

  it("computes selectors", () => {
    for (const sig of ["approve(address,uint256)", "depositForBurn(uint256,uint32,bytes32,address,bytes32,uint256,uint32)", "receiveMessage(bytes,bytes)"]) {
      expect(selector(sig)).toBe(viem.toFunctionSelector(sig));
    }
  });

  it("encodes approve and both burns, with hook data of every length", () => {
    const usdc = viem.getAddress(addresses[0]!);
    const messenger = CCTP_CONTRACTS.mainnet.tokenMessenger;
    for (const amount of [0n, 1n, 1_000_000n, 2n ** 256n - 1n]) {
      expect(approveCalldata(messenger, amount)).toBe(viem.encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [messenger, amount] }));
    }
    const hooks: viem.Hex[] = ["0x", "0x01", FORWARD_HOOK_DATA, forwardHookDataWithAccountSetup(bytes(32, 9)), bytes(31, 3), bytes(33, 4), bytes(64, 5), bytes(200, 6)];
    for (let i = 0; i < hooks.length; i++) {
      const a = {
        amount: BigInt(i) * 123_456_789n + 1n,
        destinationDomain: [0, 5, 6, 29, 26, 4_294_967_295][i % 6]!,
        mintRecipient: bytes(32, 100 + i),
        burnToken: usdc,
        destinationCaller: i % 2 ? bytes(32, 200 + i) : (`0x${"0".repeat(64)}` as viem.Hex),
        maxFee: BigInt(i * 1000),
        minFinalityThreshold: i % 2 ? 1000 : 2000,
      };
      const args = [a.amount, a.destinationDomain, a.mintRecipient, a.burnToken, a.destinationCaller, a.maxFee, a.minFinalityThreshold] as const;
      expect(burnCall(a)).toBe(viem.encodeFunctionData({ abi: tokenMessengerV2Abi, functionName: "depositForBurn", args }));
      expect(burnCall({ ...a, hookData: hooks[i]! })).toBe(
        viem.encodeFunctionData({ abi: tokenMessengerV2Abi, functionName: "depositForBurnWithHook", args: [...args, hooks[i]!] }),
      );
    }
  });

  it("encodes two dynamic arguments and the gas-drop hook", () => {
    const m = bytes(248, 11);
    const att = bytes(130, 12);
    expect(viem.concat([selector("receiveMessage(bytes,bytes)"), encodeArgs([{ type: "bytes", value: m }, { type: "bytes", value: att }])])).toBe(
      viem.encodeFunctionData({ abi: messageTransmitterV2Abi, functionName: "receiveMessage", args: [m, att] }),
    );
    for (const [i, fee] of [0n, 500_000n, 2n ** 256n - 1n].entries()) {
      const r = viem.getAddress(addresses[i + 5]!);
      expect(encodeGasDropHook(r, fee)).toBe(
        viem.encodeAbiParameters([{ type: "bytes4" }, { type: "address" }, { type: "uint256" }], ["0x49554231", r, fee]),
      );
    }
  });

  it("refuses values that don't fit their type", () => {
    const base = { amount: 1n, destinationDomain: 0, mintRecipient: bytes(32, 1), burnToken: addresses[0]!, destinationCaller: bytes(32, 2), maxFee: 0n, minFinalityThreshold: 1000 };
    expect(() => burnCall({ ...base, destinationDomain: 2 ** 32 })).toThrow();
    expect(() => burnCall({ ...base, amount: -1n })).toThrow();
    expect(() => burnCall({ ...base, amount: 2n ** 256n })).toThrow();
    expect(() => burnCall({ ...base, mintRecipient: bytes(20, 1) })).toThrow();
    expect(() => burnCall({ ...base, burnToken: "0x1234" })).toThrow();
  });
});

import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

describe("loadConfig", () => {
  it("keeps read overrides and log endpoints separate", () => {
    const c = loadConfig({
      RPC_29: "http://172.30.0.1:8545",
      LOG_RPC_19: "https://keyed-hyperevm.example/abc@1000,https://backup.example@200",
    });
    expect(c.rpcOverrides[29]).toEqual(["http://172.30.0.1:8545"]);
    expect(c.logRpcOverrides[29]).toBeUndefined();
    expect(c.logRpcOverrides[19]).toEqual([
      { url: "https://keyed-hyperevm.example/abc", span: 1000 },
      { url: "https://backup.example", span: 200 },
    ]);
    expect(c.mode).toBe("shadow");
    expect(c.legacyReceivers).toHaveLength(2);
  });

  it("accepts Choice v2's network names and checks CHAIN_ID against them", () => {
    expect(loadConfig({ NETWORK: "injective_mainnet", CHAIN_ID: "1776" }).network).toBe("mainnet");
    expect(loadConfig({ NETWORK: "injective_testnet", CHAIN_ID: "1439" }).network).toBe("testnet");
    expect(() => loadConfig({ NETWORK: "injective_mainnet", CHAIN_ID: "1439" })).toThrow(/CHAIN_ID/);
  });

  it("rejects a log endpoint without a span, and relay mode without a key", () => {
    expect(() => loadConfig({ LOG_RPC_19: "https://no-span.example" })).toThrow(/url@span/);
    expect(() => loadConfig({ MODE: "relay" })).toThrow(/RELAYER_KEY_FILE/);
  });
});

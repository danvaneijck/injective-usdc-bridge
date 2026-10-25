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

  it("defaults to the deployed BridgeReceiver, which an env var can override", () => {
    expect(loadConfig({}).bridgeReceiver).toBe("0xcA5A96ECF72B3656eF7cF60BDAA42FCdb218cd4A");
    expect(loadConfig({ NETWORK: "testnet" }).bridgeReceiver).toBeUndefined();
    const other = "0x000000000000000000000000000000000000dEaD";
    expect(loadConfig({ BRIDGE_RECEIVER: other }).bridgeReceiver).toBe(other);
  });

  it("one relay floor for every kind, defaulting to 0.10 USDC, read from the old name too", () => {
    expect(loadConfig({}).minRelay).toBe(100_000n);
    expect(loadConfig({ MIN_RELAY_PLAIN_USDC: "0.25" }).minRelay).toBe(250_000n);
    expect(loadConfig({ MIN_RELAY_USDC: "1", MIN_RELAY_PLAIN_USDC: "0.25" }).minRelay).toBe(1_000_000n);
  });

  it("keeper defaults sit the health alarm under the refill mark, and refuse a low above its target", () => {
    const c = loadConfig({});
    expect(c.keeper).toMatchObject({ enabled: true, floatLowWei: 40_000_000_000_000_000n, relayerLowWei: 30_000_000_000_000_000n });
    expect(c.relayerLowInj).toBeLessThan(0.03);
    expect(loadConfig({ KEEPER: "off" }).keeper.enabled).toBe(false);
    expect(() => loadConfig({ KEEPER_FLOAT_LOW_INJ: "0.1" })).toThrow(/must not exceed/);
  });

  it("rejects a log endpoint without a span, and relay mode without a key", () => {
    expect(() => loadConfig({ LOG_RPC_19: "https://no-span.example" })).toThrow(/url@span/);
    expect(() => loadConfig({ MODE: "relay" })).toThrow(/RELAYER_KEY_FILE/);
  });
});

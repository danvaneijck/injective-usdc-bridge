/**
 * Read-only check of the chain registry against the live chains. For every
 * EVM chain and every listed RPC: eth_chainId matches, USDC reports symbol
 * USDC with 6 decimals, MessageTransmitterV2.localDomain() equals the domain,
 * and TokenMessengerV2 has code. Also confirms Iris fee quotes exist for both
 * directions with Injective.
 *
 *   npm run verify-chains -- [mainnet|testnet]
 */
import { createPublicClient, http } from "viem";
import { erc20Abi, messageTransmitterV2Abi } from "../src/abis.js";
import { type EvmChain, INJECTIVE_DOMAIN, chains } from "../src/chains.js";
import { CCTP_CONTRACTS, type Network } from "../src/constants.js";
import { IrisClient } from "../src/iris.js";

const network = (process.argv[2] ?? "mainnet") as Network;
const { tokenMessenger, messageTransmitter } = CCTP_CONTRACTS[network];
const iris = new IrisClient({ network, userAgent: "injective-usdc-bridge-verify/0.0" });

type Row = { chain: string; rpc: string; ok: boolean; detail: string };
const rows: Row[] = [];

async function checkRpc(chain: EvmChain, url: string): Promise<Row> {
  const client = createPublicClient({ transport: http(url, { timeout: 15_000, retryCount: 1 }) });
  const problems: string[] = [];
  try {
    const id = await client.getChainId();
    if (id !== chain.chainId) problems.push(`chainId ${id} != ${chain.chainId}`);
    const [symbol, decimals, domain, tmCode] = await Promise.all([
      client.readContract({ address: chain.usdc, abi: erc20Abi, functionName: "symbol" }),
      client.readContract({ address: chain.usdc, abi: erc20Abi, functionName: "decimals" }),
      client.readContract({
        address: messageTransmitter,
        abi: messageTransmitterV2Abi,
        functionName: "localDomain",
      }),
      client.getCode({ address: tokenMessenger }),
    ]);
    if (!symbol.startsWith("USDC")) problems.push(`symbol ${symbol}`);
    if (decimals !== 6) problems.push(`decimals ${decimals}`);
    if (domain !== chain.domain) problems.push(`localDomain ${domain} != ${chain.domain}`);
    if (!tmCode || tmCode === "0x") problems.push("TokenMessengerV2 has no code");
    return {
      chain: chain.key,
      rpc: url,
      ok: problems.length === 0,
      detail: problems.join("; ") || `${symbol}/${decimals} domain ${domain}`,
    };
  } catch (e) {
    return { chain: chain.key, rpc: url, ok: false, detail: (e as Error).message.split("\n")[0] ?? "error" };
  }
}

async function checkFees(chain: { key: string; domain: number; forwarding: boolean }): Promise<Row> {
  try {
    const inbound = await iris.getFees(chain.domain, INJECTIVE_DOMAIN);
    const outbound = await iris.getFees(INJECTIVE_DOMAIN, chain.domain, { forward: chain.forwarding });
    const fwd = outbound.find((t) => t.forwardFee)?.forwardFee?.med;
    if (chain.forwarding && fwd === undefined) {
      return { chain: chain.key, rpc: "iris", ok: false, detail: "forwarding flagged but no forwardFee" };
    }
    return {
      chain: chain.key,
      rpc: "iris",
      ok: inbound.length > 0 && outbound.length > 0,
      detail: `in tiers ${inbound.map((t) => `${t.finalityThreshold}:${t.minimumFee}bps`).join(",")}` +
        (fwd !== undefined ? ` | fwd med ${(fwd / 1e6).toFixed(4)} USDC` : ""),
    };
  } catch (e) {
    return { chain: chain.key, rpc: "iris", ok: false, detail: (e as Error).message };
  }
}

const all = chains(network);
const evmChains = all.filter((c): c is EvmChain => c.kind === "evm");
rows.push(...(await Promise.all(evmChains.flatMap((c) => c.rpcUrls.map((u) => checkRpc(c, u))))));
for (const c of all.filter((c) => c.domain !== INJECTIVE_DOMAIN)) {
  rows.push(await checkFees(c));
  await new Promise((r) => setTimeout(r, 150)); // stay far below Iris' 35 req/s
}

for (const r of rows) {
  console.log(`${r.ok ? "OK  " : "FAIL"} ${r.chain.padEnd(11)} ${r.rpc.padEnd(52)} ${r.detail}`);
}
const failed = rows.filter((r) => !r.ok);
console.log(`\n${rows.length - failed.length}/${rows.length} checks passed on ${network}`);
process.exit(failed.length ? 1 : 0);

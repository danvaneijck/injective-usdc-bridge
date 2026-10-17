/**
 * Live deposit from Solana to Injective through this package's own Solana
 * builder, then watches until Injective shows the mint (our relayer's job).
 * Dry run (builds and simulates) unless --send.
 *
 *   SOL_KEY_FILE=/path/key.json npm run live-solana-deposit -- --amount 1 --recipient 0x.. [--standard] [--send]
 *
 * SOL_KEY_FILE holds a Solana keypair as a JSON array of 64 bytes (secret
 * then public). It is read in-process and never printed.
 */
import { parseArgs } from "node:util";
import { formatUnits, getAddress, parseUnits } from "viem";
import { type SolanaChain, chainByKey, explorerTxUrl, injective } from "../src/chains.js";
import { USDC_DECIMALS } from "../src/constants.js";
import { IrisClient } from "../src/iris.js";
import { quoteTransfer } from "../src/quote.js";
import { createChainReader } from "../src/rpc.js";
import { solanaBalance, solanaTokenBalance } from "../src/solana.js";
import { buildSolanaBurn, submitSolanaTransaction } from "../src/solanaBurn.js";
import { resolveTransfer } from "../src/status.js";
import { readSolanaKey } from "./solanaKey.js";

const { values } = parseArgs({
  options: {
    amount: { type: "string", default: "1" },
    recipient: { type: "string" },
    standard: { type: "boolean", default: false },
    send: { type: "boolean", default: false },
    api: { type: "string", default: "https://bridge-api.choice.exchange" },
    "timeout-min": { type: "string", default: "20" },
  },
});

const network = "mainnet" as const;
if (!values.recipient) throw new Error("--recipient 0x.. (the Injective address) is required");
const key = readSolanaKey(process.env.SOL_KEY_FILE);
const owner = key.owner;

const source = chainByKey(network, "solana") as SolanaChain;
const destination = injective(network);
const recipient = getAddress(values.recipient);
const amount = parseUnits(values.amount!, USDC_DECIMALS);
const usd = (v: bigint) => `${formatUnits(v, USDC_DECIMALS)} USDC`;
const iris = new IrisClient({ network, userAgent: "injective-usdc-bridge-live/0.0" });

console.log(`owner      ${owner}`);
console.log(`route      ${source.name} -> ${destination.name}, recipient ${recipient}`);
const [usdc, sol] = await Promise.all([solanaTokenBalance(source.rpcUrls, owner, source.usdcMint), solanaBalance(source.rpcUrls, owner)]);
console.log(`balances   ${usd(usdc)}, ${formatUnits(sol, 9)} SOL`);

const route = { source, destination };
const quote = await quoteTransfer({ iris, route, amount, speed: values.standard ? "standard" : "fast" });
console.log(`quote      ${quote.speed}, maxFee ${usd(quote.maxFee)}, min received ${usd(quote.minReceived)}`);
if (usdc < amount) {
  console.log(`\nNot enough USDC on Solana: have ${usd(usdc)}, need ${usd(amount)}. Stopping.`);
  process.exit(1);
}

// Builds and simulates: a burn the program would reject stops here.
const plan = await buildSolanaBurn({ route, quote, owner, recipient });
console.log(`plan       event account ${plan.eventAccount}, cost ${formatUnits(plan.costLamports, 9)} SOL (incl. its rent)`);
if (sol < plan.costLamports) {
  console.log(`\nNot enough SOL: have ${formatUnits(sol, 9)}, need ${formatUnits(plan.costLamports, 9)}. Stopping.`);
  process.exit(1);
}
if (!values.send) {
  console.log("\nDry run (simulated OK). Re-run with --send to broadcast.");
  process.exit(0);
}

const signature = await submitSolanaTransaction(source.rpcUrls, key.sign(plan.transaction), plan.lastValidBlockHeight);
console.log(`burn       ${explorerTxUrl(source, signature)}`);

await fetch(`${values.api}/v1/transfers/hint`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ sourceDomain: source.domain, txHash: signature }),
}).then(
  (r) => console.log(`hint       ${r.status}`),
  (e) => console.log(`hint       failed: ${(e as Error).message}`),
);

const reader = createChainReader(network);
const started = Date.now();
const deadline = started + Number(values["timeout-min"]) * 60_000;
let last = "";
while (Date.now() < deadline) {
  const [leg] = await resolveTransfer({ iris, sourceDomain: source.domain, txHash: signature as `0x${string}`, isNonceUsed: reader.isNonceUsed });
  const line = `${leg?.phase}${leg?.delayReason ? ` (${leg.delayReason})` : ""}`;
  if (line !== last) {
    console.log(`${String(Math.round((Date.now() - started) / 1000)).padStart(5)}s  ${line}`);
    last = line;
  }
  if (leg?.phase === "delivered") {
    console.log(`delivered  minted ${usd(leg.burn!.amount - leg.burn!.feeExecuted)} on Injective (feeExecuted ${usd(leg.burn!.feeExecuted)})`);
    process.exit(0);
  }
  await new Promise((r) => setTimeout(r, 5_000));
}
console.log(`Not delivered after ${values["timeout-min"]} min. The burn is permissionless: the relayer or anyone can mint it.`);
process.exit(2);

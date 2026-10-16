/**
 * Live withdrawal from Injective using Circle's Forwarding Service, then
 * watches until the destination chain shows the mint. Dry run unless --send.
 *
 *   KEY_FILE=/path/to/key npm run live-withdraw -- --amount 1 --to base [--recipient 0x..] [--send]
 *   KEY_FILE=/path/to/key npm run live-withdraw -- --amount 1.5 --to solana --recipient <wallet> [--send]
 *
 * To Solana the recipient is a wallet; the burn names its USDC account, and
 * asks Circle to create that account when it does not exist yet.
 *
 * KEY_FILE holds a hex private key. It is read in-process and never printed.
 */
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { type Hex, createWalletClient, formatUnits, http, parseUnits } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { erc20Abi } from "../src/abis.js";
import { buildBurn } from "../src/burn.js";
import { chainByKey, explorerTxUrl, injective } from "../src/chains.js";
import { CCTP_CONTRACTS, USDC_DECIMALS } from "../src/constants.js";
import { IrisClient } from "../src/iris.js";
import { quoteTransfer } from "../src/quote.js";
import { createChainReader, feeOverrides, publicClientFor, toViemChain } from "../src/rpc.js";
import { checkSolanaRecipient } from "../src/solana.js";
import { resolveTransfer } from "../src/status.js";

const { values } = parseArgs({
  options: {
    amount: { type: "string", default: "1" },
    to: { type: "string", default: "base" },
    recipient: { type: "string" },
    send: { type: "boolean", default: false },
    "timeout-min": { type: "string", default: "40" },
  },
});

const network = "mainnet" as const;
const keyFile = process.env.KEY_FILE;
if (!keyFile) throw new Error("Set KEY_FILE to a file holding the hex private key");
const raw = readFileSync(keyFile, "utf8").trim();
const account = privateKeyToAccount((raw.startsWith("0x") ? raw : `0x${raw}`) as Hex);

const source = injective(network);
const destination = chainByKey(network, values.to!);
if (!destination) throw new Error(`Unknown chain ${values.to}`);
if (destination.kind === "solana" && !values.recipient) throw new Error("--recipient <Solana wallet> is required for Solana");
const recipient = values.recipient ?? account.address;
let recipientSetup = false;
if (destination.kind === "solana") {
  const check = await checkSolanaRecipient(destination.rpcUrls, recipient, destination.usdcMint);
  if (!check.ok) throw new Error(`Solana recipient refused: ${check.reason}`);
  recipientSetup = !check.tokenAccountExists;
  console.log(`usdc acct  ${check.tokenAccount} (${check.tokenAccountExists ? "exists" : "missing: Circle will create it"})`);
}
const amount = parseUnits(values.amount!, USDC_DECIMALS);
const usd = (v: bigint) => `${formatUnits(v, USDC_DECIMALS)} USDC`;

const iris = new IrisClient({ network, userAgent: "injective-usdc-bridge-live/0.0" });
const injClient = publicClientFor(source);
const reader = createChainReader(network);

console.log(`signer     ${account.address}`);
console.log(`route      ${source.name} -> ${destination.name}, recipient ${recipient}`);

const [balance, allowance, injBalance] = await Promise.all([
  injClient.readContract({ address: source.usdc, abi: erc20Abi, functionName: "balanceOf", args: [account.address] }),
  injClient.readContract({
    address: source.usdc,
    abi: erc20Abi,
    functionName: "allowance",
    args: [account.address, CCTP_CONTRACTS[network].tokenMessenger],
  }),
  injClient.getBalance({ address: account.address }),
]);
console.log(`balances   ${usd(balance)}, ${formatUnits(injBalance, 18)} INJ`);

const route = { source, destination };
const quote = await quoteTransfer({ iris, route, amount, recipientSetup });
console.log(
  `quote      amount ${usd(quote.amount)}, forwarded ${quote.forwarded}, setup ${quote.recipientSetup}, forwarding fee ${usd(quote.forwardingFee)}, ` +
    `maxFee ${usd(quote.maxFee)}, min received ${usd(quote.minReceived)}`,
);
const plan = buildBurn({ network, route, quote, recipient, allowance });

if (balance < amount) {
  console.log(`\nNot enough USDC on Injective: have ${usd(balance)}, need ${usd(amount)}. Stopping.`);
  process.exit(1);
}
if (!values.send) {
  console.log(`\nDry run. Would send: ${plan.approve ? "approve, then " : ""}burn to ${plan.burn.to}.`);
  if (!plan.approve) {
    const gas = await injClient.estimateGas({ account: account.address, to: plan.burn.to, data: plan.burn.data });
    console.log(`burn gas estimate ${gas}`);
  }
  console.log("Re-run with --send to broadcast.");
  process.exit(0);
}

const wallet = createWalletClient({ account, chain: toViemChain(source), transport: http(source.rpcUrls[0]) });
async function send(label: string, call: { to: Hex; data: Hex }) {
  const fees = await feeOverrides(injClient, source);
  const hash = await wallet.sendTransaction({ to: call.to, data: call.data, ...fees });
  console.log(`${label.padEnd(10)} ${explorerTxUrl(source, hash)}`);
  const receipt = await injClient.waitForTransactionReceipt({ hash, timeout: 120_000 });
  if (receipt.status !== "success") throw new Error(`${label} reverted: ${hash}`);
  return hash;
}

if (plan.approve) await send("approve", plan.approve);
const burnTx = await send("burn", plan.burn);

const started = Date.now();
const deadline = started + Number(values["timeout-min"]) * 60_000;
let last = "";
while (Date.now() < deadline) {
  const [leg] = await resolveTransfer({
    iris,
    sourceDomain: source.domain,
    txHash: burnTx,
    isNonceUsed: reader.isNonceUsed,
    destinationBlock: reader.destinationBlock,
  });
  const line = `${leg?.phase}${leg?.delayReason ? ` (${leg.delayReason})` : ""}`;
  if (line !== last) {
    console.log(`${String(Math.round((Date.now() - started) / 1000)).padStart(5)}s  ${line}`);
    last = line;
  }
  if (leg?.phase === "delivered") {
    console.log(`delivered  minted ${usd(leg.burn!.amount - leg.burn!.feeExecuted)} (feeExecuted ${usd(leg.burn!.feeExecuted)})`);
    if (leg.forwardTxHash) {
      console.log(`forwarded  ${leg.forwardState} ${explorerTxUrl(destination, leg.forwardTxHash)}`);
    }
    process.exit(0);
  }
  await new Promise((r) => setTimeout(r, 10_000));
}
console.log(`Not delivered after ${values["timeout-min"]} min. Burn ${burnTx} is permissionless; mint it manually if Circle never forwards.`);
process.exit(2);

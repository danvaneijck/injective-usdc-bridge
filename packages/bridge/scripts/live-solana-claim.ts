/**
 * Live manual claim of a transfer to Solana: the receive_message a user sends
 * from the widget when Circle does not deliver. Waits for Circle's approval,
 * builds and simulates the claim, then (with --send) signs, sends and checks
 * the USDC arrived. Dry run unless --send.
 *
 *   SOL_KEY_FILE=/path/key.json npm run live-solana-claim -- --tx 0x<Injective burn> [--send]
 *
 * Make a burn Circle will not deliver with live-withdraw --to solana --no-forward.
 * SOL_KEY_FILE pays (any wallet may); it is read in-process and never printed.
 */
import { parseArgs } from "node:util";
import { type Hex, formatUnits } from "viem";
import { INJECTIVE_DOMAIN, type SolanaChain, chainByKey, explorerTxUrl } from "../src/chains.js";
import { USDC_DECIMALS } from "../src/constants.js";
import { IrisClient } from "../src/iris.js";
import { decodeMessage } from "../src/message.js";
import { isSolanaNonceUsed, parseTokenAccount, solanaAccount, solanaBalance } from "../src/solana.js";
import { submitSolanaTransaction } from "../src/solanaBurn.js";
import { buildSolanaClaim } from "../src/solanaClaim.js";
import { readSolanaKey } from "./solanaKey.js";

const { values } = parseArgs({
  options: {
    tx: { type: "string" },
    send: { type: "boolean", default: false },
    "timeout-min": { type: "string", default: "40" },
  },
});
if (!values.tx) throw new Error("--tx 0x<Injective burn hash> is required");

const network = "mainnet" as const;
const chain = chainByKey(network, "solana") as SolanaChain;
const key = readSolanaKey(process.env.SOL_KEY_FILE);
const iris = new IrisClient({ network, userAgent: "injective-usdc-bridge-live/0.0" });
const usd = (v: bigint) => `${formatUnits(v, USDC_DECIMALS)} USDC`;
console.log(`payer      ${key.owner}`);

// Circle's approval first: the claim carries its attestation.
const deadline = Date.now() + Number(values["timeout-min"]) * 60_000;
let m = null as Awaited<ReturnType<IrisClient["getMessages"]>>[number] | null;
for (;;) {
  const messages = await iris.getMessages(INJECTIVE_DOMAIN, values.tx as Hex);
  m = messages.find((x) => x.decodedMessage?.destinationDomain === String(chain.domain)) ?? null;
  if (m && m.attestation !== "PENDING" && m.status === "complete") break;
  if (Date.now() > deadline) throw new Error("Circle has not approved the burn yet");
  console.log(`waiting    ${m ? m.status : "not indexed by Circle yet"}`);
  await new Promise((r) => setTimeout(r, 10_000));
}
const message = m.message;
const attestation = m.attestation as Hex;
const nonce = decodeMessage(message).nonce;
console.log(`approved   nonce ${nonce}`);

const plan = await buildSolanaClaim({ chain, message, attestation, payer: key.owner, owners: [key.owner] });
const sol = await solanaBalance(chain.rpcUrls, key.owner);
console.log(
  `plan       ${plan.transaction.length} bytes, mints into ${plan.tokenAccount}${plan.createsTokenAccount ? " (opens it)" : ""}, cost ${formatUnits(plan.costLamports, 9)} SOL; have ${formatUnits(sol, 9)} SOL`,
);
if (sol < plan.costLamports) {
  console.log("\nNot enough SOL to pay for the claim. Stopping.");
  process.exit(1);
}
if (!values.send) {
  console.log("\nDry run (simulated OK). Re-run with --send to broadcast.");
  process.exit(0);
}

const before = await solanaAccount(chain.rpcUrls, plan.tokenAccount);
const signature = await submitSolanaTransaction(chain.rpcUrls, key.sign(plan.transaction), plan.lastValidBlockHeight);
console.log(`claim      ${explorerTxUrl(chain, signature)}`);
const after = await solanaAccount(chain.rpcUrls, plan.tokenAccount);
const got = (after ? (parseTokenAccount(after)?.amount ?? 0n) : 0n) - (before ? (parseTokenAccount(before)?.amount ?? 0n) : 0n);
console.log(`delivered  ${usd(got)} into ${plan.tokenAccount}; nonce used: ${await isSolanaNonceUsed(chain.rpcUrls, nonce)}`);

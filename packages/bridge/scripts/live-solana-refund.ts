/**
 * Live refund of a Solana burn's event-account deposit (reclaim_event_account),
 * what the widget's Reclaim button sends. Circle allows it 5 days after the
 * burn. Dry run (builds and simulates) unless --send.
 *
 *   SOL_KEY_FILE=/path/key.json npm run live-solana-refund -- --sig <Solana burn signature> [--send]
 *
 * SOL_KEY_FILE must be the wallet that made the burn; it is read in-process
 * and never printed.
 */
import { parseArgs } from "node:util";
import { base58 } from "@scure/base";
import { type Hex, formatUnits } from "viem";
import { type SolanaChain, chainByKey, explorerTxUrl } from "../src/chains.js";
import { IrisClient } from "../src/iris.js";
import { SOLANA_TOKEN_MESSENGER_MINTER_V2, solanaAccount, solanaBalance, solanaRpc } from "../src/solana.js";
import { SOLANA_BURN_ACCOUNTS, decodeSolanaBurn, submitSolanaTransaction } from "../src/solanaBurn.js";
import { buildSolanaRefund } from "../src/solanaClaim.js";
import { readSolanaKey } from "./solanaKey.js";

const { values } = parseArgs({
  options: {
    sig: { type: "string" },
    send: { type: "boolean", default: false },
  },
});
if (!values.sig) throw new Error("--sig <Solana burn signature> is required");

const network = "mainnet" as const;
const chain = chainByKey(network, "solana") as SolanaChain;
const key = readSolanaKey(process.env.SOL_KEY_FILE);
console.log(`payee      ${key.owner}`);

// The burn names its event account; Circle has the attested message.
interface Ix {
  programIdIndex: number;
  accounts: number[];
  data: string;
}
const tx = await solanaRpc<{
  transaction: { message: { accountKeys: string[]; instructions: Ix[] } };
  meta: { loadedAddresses?: { writable: string[]; readonly: string[] } };
} | null>(chain.rpcUrls, "getTransaction", [values.sig, { encoding: "json", commitment: "confirmed", maxSupportedTransactionVersion: 1 }]);
if (!tx) throw new Error("The RPC does not have that transaction");
const keys = [...tx.transaction.message.accountKeys, ...(tx.meta.loadedAddresses?.writable ?? []), ...(tx.meta.loadedAddresses?.readonly ?? [])];
const burn = tx.transaction.message.instructions.find(
  (ix) => keys[ix.programIdIndex] === SOLANA_TOKEN_MESSENGER_MINTER_V2 && decodeSolanaBurn(base58.decode(ix.data)) !== null,
);
if (!burn) throw new Error("No CCTP burn in that transaction");
const eventAccount = keys[burn.accounts[SOLANA_BURN_ACCOUNTS.messageSentEventData]!]!;

const iris = new IrisClient({ network, userAgent: "injective-usdc-bridge-live/0.0" });
const [m] = await iris.getMessages(chain.domain, values.sig as Hex);
if (!m || m.attestation === "PENDING") throw new Error("Circle has not approved the burn yet");

const plan = await buildSolanaRefund({ chain, eventAccount, message: m.message, attestation: m.attestation as Hex, payee: key.owner });
console.log(
  `plan       event account ${eventAccount}: refund ${formatUnits(plan.refundLamports, 9)} SOL for ${formatUnits(plan.costLamports, 9)} SOL in fees`,
);
if (!values.send) {
  console.log("\nDry run (simulated OK). Re-run with --send to broadcast.");
  process.exit(0);
}

const before = await solanaBalance(chain.rpcUrls, key.owner);
const signature = await submitSolanaTransaction(chain.rpcUrls, key.sign(plan.transaction), plan.lastValidBlockHeight);
console.log(`refund     ${explorerTxUrl(chain, signature)}`);
const after = await solanaBalance(chain.rpcUrls, key.owner);
console.log(`balance    +${formatUnits(after - before, 9)} SOL; event account ${(await solanaAccount(chain.rpcUrls, eventAccount)) ? "STILL OPEN" : "closed"}`);

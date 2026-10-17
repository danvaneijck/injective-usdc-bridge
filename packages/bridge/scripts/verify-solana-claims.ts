/**
 * Checks the Solana claim and refund against mainnet without signing or
 * spending anything (simulations skip signature checks):
 *
 *  1. refund: finds burns to Injective older than Circle's 5-day window whose
 *     event accounts are still open, and simulates reclaim_event_account for
 *     their rent payer. Circle's program verifies the attestation and closes
 *     the account in simulation.
 *  2. claim: takes a recent real receive_message from Injective, rebuilds it,
 *     and simulates our v0 transaction through the lookup table. It is
 *     delivered already, so the program must stop exactly at the nonce
 *     account ("already in use"), past the table load and account checks.
 *
 *   npm run verify-solana-claims
 *
 * Signature history comes from api.mainnet-beta (the registry's publicnode
 * keeps ~1.5 days); everything else uses the registry's RPC.
 */
import { base58 } from "@scure/base";
import { type Hex, bytesToHex } from "viem";
import { type SolanaChain, chainByKey } from "../src/chains.js";
import { IrisClient } from "../src/iris.js";
import { decodeMessage } from "../src/message.js";
import { SOLANA_MESSAGE_TRANSMITTER_V2, SOLANA_TOKEN_MESSENGER_MINTER_V2, remoteTokenMessengerAddress, solanaAccount, solanaRpc } from "../src/solana.js";
import { SOLANA_BURN_ACCOUNTS, SolanaSimulationError, decodeSolanaBurn, prepareSolanaTransaction } from "../src/solanaBurn.js";
import {
  EVENT_ACCOUNT_REFUND_DELAY_SEC,
  RECEIVE_MESSAGE_DISCRIMINATOR,
  buildSolanaRefund,
  parseLookupTable,
  readMessageSentAccounts,
  receiveMessageInstruction,
} from "../src/solanaClaim.js";

const HISTORY = [process.env.SOLANA_HISTORY_RPC ?? "https://api.mainnet-beta.solana.com"];
const chain = chainByKey("mainnet", "solana") as SolanaChain;
const rpc = chain.rpcUrls;
const iris = new IrisClient({ network: "mainnet", userAgent: "injective-usdc-bridge-verify/0.0" });
const watched = remoteTokenMessengerAddress(29);

interface Ix {
  programIdIndex: number;
  accounts: number[];
  data: string;
}
interface Tx {
  blockTime: number;
  meta: { err: unknown; loadedAddresses?: { writable: string[]; readonly: string[] } };
  transaction: { message: { accountKeys: string[]; instructions: Ix[] } };
}
const getTx = (urls: readonly string[], sig: string) =>
  solanaRpc<Tx | null>(urls, "getTransaction", [sig, { encoding: "json", commitment: "confirmed", maxSupportedTransactionVersion: 1 }]);
const keysOf = (tx: Tx) => [...tx.transaction.message.accountKeys, ...(tx.meta.loadedAddresses?.writable ?? []), ...(tx.meta.loadedAddresses?.readonly ?? [])];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
const sigs = await solanaRpc<{ signature: string; err: unknown; blockTime: number }[]>(HISTORY, "getSignaturesForAddress", [watched, { limit: 1000 }]);

// 1. Refunds of real, old, unclaimed event accounts.
const cutoff = Date.now() / 1000 - EVENT_ACCOUNT_REFUND_DELAY_SEC - 86_400;
const burns: { sig: string; event: string }[] = [];
for (const s of sigs.filter((x) => !x.err && x.blockTime < cutoff).slice(0, 30)) {
  if (burns.length >= 3) break;
  await sleep(400); // api.mainnet-beta rate limit
  const tx = await getTx(HISTORY, s.signature).catch(() => null);
  if (!tx) continue;
  const keys = keysOf(tx);
  for (const ix of tx.transaction.message.instructions) {
    if (keys[ix.programIdIndex] !== SOLANA_TOKEN_MESSENGER_MINTER_V2 || !decodeSolanaBurn(base58.decode(ix.data))) continue;
    burns.push({ sig: s.signature, event: keys[ix.accounts[SOLANA_BURN_ACCOUNTS.messageSentEventData]!]! });
  }
}
const events = await readMessageSentAccounts(rpc, burns.map((b) => b.event));
let refunds = 0;
for (const b of burns) {
  const account = events.get(b.event);
  if (!account) continue; // refunded already
  const [m] = await iris.getMessages(chain.domain, b.sig as Hex);
  if (!m || m.attestation === "PENDING") continue;
  try {
    const plan = await buildSolanaRefund({ chain, eventAccount: b.event, message: m.message, attestation: m.attestation as Hex, payee: account.rentPayer, rpcUrls: rpc });
    console.log(`refund OK   ${b.event}: ${plan.refundLamports} lamports back for ${plan.costLamports} in fees, ${plan.transaction.length} bytes`);
    refunds++;
  } catch (e) {
    console.log(`refund FAIL ${b.event}: ${(e as Error).message}`);
    failures++;
  }
}
if (refunds === 0) console.log("refund      no open event account older than 5 days found to simulate");

// 2. A claim, rebuilt from a real receive_message and simulated as ours.
let claimed = false;
for (const s of sigs.filter((x) => !x.err).slice(0, 40)) {
  const tx = await getTx(rpc, s.signature).catch(() => null);
  if (!tx) continue;
  const keys = keysOf(tx);
  const ix = tx.transaction.message.instructions.find(
    (i) => keys[i.programIdIndex] === SOLANA_MESSAGE_TRANSMITTER_V2 && RECEIVE_MESSAGE_DISCRIMINATOR.every((b, j) => base58.decode(i.data)[j] === b),
  );
  if (!ix) continue;
  const data = base58.decode(ix.data);
  const v = new DataView(data.buffer, data.byteOffset);
  const len = v.getUint32(8, true);
  const message = bytesToHex(data.slice(12, 12 + len));
  const attestation = bytesToHex(data.slice(16 + len, 16 + len + v.getUint32(12 + len, true)));
  const accounts = ix.accounts.map((i) => keys[i]!);
  const ours = receiveMessageInstruction({
    payer: accounts[0]!,
    message,
    attestation,
    recipientTokenAccount: accounts[15]!,
    feeRecipientTokenAccount: accounts[14]!,
    mint: chain.usdcMint,
  });
  const sameKeys = ours.keys.every((k, i) => k.pubkey === accounts[i]) && ours.keys.length === accounts.length;
  const sameData = ours.data.length === data.length && ours.data.every((b, i) => b === data[i]);
  console.log(`claim ${sameKeys && sameData ? "OK  " : "FAIL"}  rebuilt ${s.signature.slice(0, 16)}... (nonce ${decodeMessage(message).nonce.slice(0, 18)}...): accounts ${sameKeys ? "match" : "DIFFER"}, data ${sameData ? "matches" : "DIFFERS"}`);
  if (!sameKeys || !sameData) failures++;

  const table = parseLookupTable(chain.receiveLookupTable!, await solanaAccount(rpc, chain.receiveLookupTable!));
  if (!table) {
    console.log("claim FAIL  lookup table not readable or deactivated");
    failures++;
    break;
  }
  try {
    await prepareSolanaTransaction({ rpcUrls: rpc, payer: accounts[0]!, instructions: [ours], priorityAccounts: [], tables: [table] });
    console.log("claim FAIL  simulation passed for a delivered transfer");
    failures++;
  } catch (e) {
    const atNonce = e instanceof SolanaSimulationError && /already in use/.test(e.logs.join(" ")) && e.logs.some((l) => l.includes(`${SOLANA_MESSAGE_TRANSMITTER_V2} invoke`));
    console.log(`claim ${atNonce ? "OK  " : "FAIL"}  v0 transaction through ${table.address}: ${atNonce ? "stops at the used nonce, as a delivered transfer must" : (e as Error).message}`);
    if (!atNonce) failures++;
  }
  claimed = true;
  break;
}
if (!claimed) console.log("claim       no recent receive_message found to rebuild");

console.log(failures ? `\n${failures} check(s) failed` : "\nall good");
process.exit(failures ? 1 : 0);

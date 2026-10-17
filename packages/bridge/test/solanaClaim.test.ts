import { base58, base64 } from "@scure/base";
import {
  AddressLookupTableAccount,
  ComputeBudgetProgram,
  Keypair,
  PublicKey,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import { type Hex, bytesToHex, concat, hexToBytes, pad, size } from "viem";
import { describe, expect, it } from "vitest";
import { chainByKey, type SolanaChain } from "../src/chains.js";
import { SPL_TOKEN_PROGRAM, associatedTokenAddress, solanaToBytes32, usedNonceAddress } from "../src/solana.js";
import { SOLANA_MAX_TRANSACTION_BYTES, compileV0Message, computeBudgetInstructions } from "../src/solanaBurn.js";
import {
  EVENT_ACCOUNT_REFUND_DELAY_SEC,
  MESSAGE_SENT_DISCRIMINATOR,
  RECEIVE_MESSAGE_DISCRIMINATOR,
  RECLAIM_EVENT_ACCOUNT_DISCRIMINATOR,
  buildSolanaClaim,
  buildSolanaRefund,
  createAssociatedTokenAccountInstruction,
  parseLookupTable,
  parseMessageSentAccount,
  receiveMessageInstruction,
  reclaimEventAccountInstruction,
} from "../src/solanaClaim.js";
import { decodeMessage } from "../src/message.js";

const solana = chainByKey("mainnet", "solana") as SolanaChain;
const USDC = solana.usdcMint;
const MT = "CCTPV2Sm4AdWt5296sk4P66VBZ7bEhcARwFaaS9YPbeC";

/**
 * Real mainnet mint, Injective -> Solana, 494.83 USDC, plain burn (slot
 * 457688603, 2026-10-16): the payer opened the recipient's USDC account and
 * called receive_message in one transaction.
 */
const REAL = {
  signature: "5vm9jNGZ62LSGLbE3y2B6jzZcRMPfwrZTZGxrsLZuuBxVDy9t4BEd3Lv8uezNSxQHmz9sQbNn9NFtfXC45SeQDdp",
  payer: "BcSiTiwANLSzq5P3nhiXvifzZ6MYg8Nm3YyLtFXAViFq",
  owner: "LoiT4gADwanEpsYC41SncJ1ePKkc22rKHer8kuaevGn",
  tokenAccount: "AmEb5nWjkqM9m1BJWish85xkNtXeQ57KHA62bZQjRLgz",
  feeRecipientTokenAccount: "6zNSMmZGMhNyqZMHkx2L63DLuqh5qoqBhaQJPJD7Fvt3",
  message:
    "0x000000010000001d000000056ee603a867fdaf0c27128bcda02b8adf4f917c3e40ec4cfc50f234d3231e34f400000000000000000000000028b5a0e9c621a5badaa536219b3a228c8168cf5da65fc81d0fefa8860cb3b83f089b0224be8a6687b7ae49f594c0b9b4d7e938930000000000000000000000000000000000000000000000000000000000000000000007d0000007d000000001000000000000000000000000a00c59ff5a080d2b954d0c75e46e22a0c371235a910e19fd124b7d3ce8d6aa3c6694b388ba311c7a0e12f1391fa310fc01e2c07b000000000000000000000000000000000000000000000000000000001d7e91f5000000000000000000000000ecec3970ca674278da8d9b1c484acaf6b20181f5000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000" as Hex,
  attestation:
    "0x2ad8fb83cd7ec08f64dd9779c80a2480c8f3056df281d56a4bfb1438fa5f787f10bc8e899857cf9d5fe8d5dd4c03669d816b641407f740104503d7105a97522f1c9189959766afb539ff6980a3afd557005a73e2ac71d7a5c100d487f3b73f11bc6982c7969f9309c9f16b4c962af6b683f391dc3c0a974e39ad8895fe0d724d8d1b" as Hex,
  data: "6EKkKVmdkFDp43gJDZvwnYcfcxBvdijAcPb25SphoDEm1qyfryZyUJmkg9jR56jarHjRjSqKUzTDCV7MSnh3xMX4ygkoTqqpzYKf11nCBkkKxekkk9kRu2iJYEFMjFghe44bu1iUast3qm1fovy9D4qtbKJgCmUHYwQfWVxLhC8jJ5HuyLJC7yYE4VrnbJqzAweLUB4Prhfi2jTkLf46FKDsM8XM2NCs8dpqxU5ohMAwPAEz3QCThDfSmqL5VSaTjvEUXgGQ6BtCeQ83tnZ9ECij7JnScStjc4meEPUEuMJ3a4eCVbtFPzBk4i1fJa4wJrYqafmaDPbpfXawEyUUAPZiTSc71TNPxn3DGKck537NVWo9YiW6GQjXfBfmTFKSCyQRpWxwfkZ2Wk46EbktdFdC4ZcQHzC4uB3Lv1cSL78KJkXBBjTRuaTu45gbMLu5vhouWHVKbDkfbxybfbs76ZAbqztyCSSo5q3oD7CowJngoy47tciCrCyWvJa1u4uo9USh5thv7uYCvV313jBzzFbcoKYFKZ4pETAByxt6aG1nJFzaAwYRmoV8EAMX8fhapoFfXmZtBvbFBDChWzpCAuXkBWqvG2kTjRhPHq8H5DkUAtfzExQx3fuSBX3UF4pdxJQCuLmZtwh6hicCSwUSDymycjCFPXs9u28izYRLYJqGvkhrBdd8vPWbxv9fsF8xT2RvcXYQA",
  accounts:
    "BcSiTiwANLSzq5P3nhiXvifzZ6MYg8Nm3YyLtFXAViFq,BcSiTiwANLSzq5P3nhiXvifzZ6MYg8Nm3YyLtFXAViFq,DsAdX23SVpTPYhKP2ua1mx8gTPqLyzx7a43cyxYjS2up,W1k5ijkaSTo5iA5zChNpfzcy796fLhkBxfmJuR8W8HU,78w1XQb39q335Rtmfx5kXocc9DZZPEt36rvY3zQJbgjx,CCTPV2vPZJS2u2BBsUoscuikbYjnpFmbFsvVuJdgUMQe,11111111111111111111111111111111,2PcXTomVAbX5Es1NUZUkxwuCm8tvV4NmRk3fmQWFCWoV,CCTPV2Sm4AdWt5296sk4P66VBZ7bEhcARwFaaS9YPbeC,AawthJCGRmggpfv9MMWV6Jmo9cue4gL9wUZgRBShg58W,2tFfjwfzfzBrfftSrbsC5L3PmCtvkNfLLyXDTA7KYvng,E1bQJ8eMMn3zmeSewW3HQ8zmJr7KR75JonbwAtWx2bux,CRBBbuLCyrkQy4dCTHxqstSmDQv4ajBeUVb9qUdMVaP1,3ScA5MbfFbdPQeMP2h5Wk5Bq7zQqCsn2REjKrzUHMpKo,6zNSMmZGMhNyqZMHkx2L63DLuqh5qoqBhaQJPJD7Fvt3,AmEb5nWjkqM9m1BJWish85xkNtXeQ57KHA62bZQjRLgz,6xTBTqJMBr5m7BKqVxmW2x11DfqUwtD3TJsqpxELx72L,TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA,6TCCnJ9R1m1RXFzyoH7GYH2J6NJDtZaUvfipPuLWxHNd,CCTPV2vPZJS2u2BBsUoscuikbYjnpFmbFsvVuJdgUMQe".split(
      ",",
    ),
  ataAccounts:
    "BcSiTiwANLSzq5P3nhiXvifzZ6MYg8Nm3YyLtFXAViFq,AmEb5nWjkqM9m1BJWish85xkNtXeQ57KHA62bZQjRLgz,LoiT4gADwanEpsYC41SncJ1ePKkc22rKHer8kuaevGn,EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v,11111111111111111111111111111111,TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA".split(
      ",",
    ),
};

/** The v1 table's entries on mainnet (2026-10-17). */
const TABLE = {
  address: solana.receiveLookupTable!,
  addresses:
    "DsAdX23SVpTPYhKP2ua1mx8gTPqLyzx7a43cyxYjS2up,W1k5ijkaSTo5iA5zChNpfzcy796fLhkBxfmJuR8W8HU,2PcXTomVAbX5Es1NUZUkxwuCm8tvV4NmRk3fmQWFCWoV,AawthJCGRmggpfv9MMWV6Jmo9cue4gL9wUZgRBShg58W,2tFfjwfzfzBrfftSrbsC5L3PmCtvkNfLLyXDTA7KYvng,E1bQJ8eMMn3zmeSewW3HQ8zmJr7KR75JonbwAtWx2bux,CRBBbuLCyrkQy4dCTHxqstSmDQv4ajBeUVb9qUdMVaP1,3ScA5MbfFbdPQeMP2h5Wk5Bq7zQqCsn2REjKrzUHMpKo,6xTBTqJMBr5m7BKqVxmW2x11DfqUwtD3TJsqpxELx72L,6TCCnJ9R1m1RXFzyoH7GYH2J6NJDtZaUvfipPuLWxHNd,6zNSMmZGMhNyqZMHkx2L63DLuqh5qoqBhaQJPJD7Fvt3,CCTPV2vPZJS2u2BBsUoscuikbYjnpFmbFsvVuJdgUMQe,TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA,11111111111111111111111111111111".split(
      ",",
    ),
};

function tableAccount(addresses: readonly string[], deactivation = 0xffff_ffff_ffff_ffffn) {
  const data = new Uint8Array(56 + 32 * addresses.length);
  const v = new DataView(data.buffer);
  v.setUint32(0, 1, true);
  v.setBigUint64(4, deactivation, true);
  addresses.forEach((a, i) => data.set(base58.decode(a), 56 + 32 * i));
  return { owner: "AddressLookupTab1e1111111111111111111111111", lamports: 1, data };
}

function eventAccount(rentPayer: string, createdAt: number, message: Hex, lamports = 2_824_480) {
  const msg = hexToBytes(message);
  const data = new Uint8Array(52 + msg.length);
  data.set(MESSAGE_SENT_DISCRIMINATOR, 0);
  data.set(base58.decode(rentPayer), 8);
  const v = new DataView(data.buffer);
  v.setBigInt64(40, BigInt(createdAt), true);
  v.setUint32(48, msg.length, true);
  data.set(msg, 52);
  return { owner: MT, lamports, data };
}

const web3Ix = (ix: { programId: string; keys: { pubkey: string; isSigner: boolean; isWritable: boolean }[]; data: Uint8Array }) =>
  new TransactionInstruction({
    programId: new PublicKey(ix.programId),
    keys: ix.keys.map((k) => ({ ...k, pubkey: new PublicKey(k.pubkey) })),
    data: Buffer.from(ix.data),
  });

describe("Solana claim and refund instructions", () => {
  it("uses Anchor's discriminators (v1's, which is in production since August)", () => {
    expect(bytesToHex(RECEIVE_MESSAGE_DISCRIMINATOR)).toBe("0x26907fe11fe1ee19");
    expect(RECLAIM_EVENT_ACCOUNT_DISCRIMINATOR).toHaveLength(8);
  });

  it("rebuilds a real mainnet receive_message byte for byte", () => {
    const ix = receiveMessageInstruction({
      payer: REAL.payer,
      message: REAL.message,
      attestation: REAL.attestation,
      recipientTokenAccount: REAL.tokenAccount,
      feeRecipientTokenAccount: REAL.feeRecipientTokenAccount,
      mint: USDC,
    });
    expect(ix.programId).toBe(MT);
    expect(ix.keys.map((k) => k.pubkey)).toEqual(REAL.accounts);
    expect([...ix.data]).toEqual([...base58.decode(REAL.data)]);
    expect(ix.keys[4]!.pubkey).toBe(usedNonceAddress(decodeMessage(REAL.message).nonce));
  });

  it("opens the recipient's USDC account as the real claim did", () => {
    expect(associatedTokenAddress(REAL.owner, USDC)).toBe(REAL.tokenAccount);
    const ix = createAssociatedTokenAccountInstruction(REAL.payer, REAL.owner, USDC);
    expect(ix.keys.map((k) => k.pubkey)).toEqual(REAL.ataAccounts);
    expect([...ix.data]).toEqual([1]); // CreateIdempotent
  });

  it("compiles a v0 transaction exactly as @solana/web3.js does", () => {
    const payer = Keypair.generate().publicKey;
    const blockhash = base58.encode(new Uint8Array(32).fill(3));
    const ata = createAssociatedTokenAccountInstruction(payer.toBase58(), REAL.owner, USDC);
    const recv = receiveMessageInstruction({
      payer: payer.toBase58(),
      message: REAL.message,
      attestation: REAL.attestation,
      recipientTokenAccount: REAL.tokenAccount,
      feeRecipientTokenAccount: REAL.feeRecipientTokenAccount,
      mint: USDC,
    });
    const ours = compileV0Message(payer.toBase58(), [...computeBudgetInstructions(90_000, 777), ata, recv], blockhash, [TABLE]);
    const theirs = new TransactionMessage({
      payerKey: payer,
      recentBlockhash: blockhash,
      instructions: [
        ComputeBudgetProgram.setComputeUnitLimit({ units: 90_000 }),
        ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 777 }),
        web3Ix(ata),
        web3Ix(recv),
      ],
    }).compileToV0Message([
      new AddressLookupTableAccount({
        key: new PublicKey(TABLE.address),
        state: { deactivationSlot: 0xffff_ffff_ffff_ffffn, lastExtendedSlot: 0, lastExtendedSlotStartIndex: 0, addresses: TABLE.addresses.map((a) => new PublicKey(a)) },
      }),
    ]);
    expect([...ours.bytes]).toEqual([...theirs.serialize()]);
    expect(ours.signers).toEqual([payer.toBase58()]);
  });

  it("reads a live lookup table and ignores a deactivating one", () => {
    expect(parseLookupTable("t", tableAccount(TABLE.addresses))?.addresses).toEqual(TABLE.addresses);
    expect(parseLookupTable("t", tableAccount(TABLE.addresses, 123n))).toBeNull();
    expect(parseLookupTable("t", { ...tableAccount(TABLE.addresses), owner: SPL_TOKEN_PROGRAM })).toBeNull();
    expect(parseLookupTable("t", null)).toBeNull();
  });

  it("reads an event account and builds its reclaim", () => {
    const payer = Keypair.generate().publicKey.toBase58();
    const parsed = parseMessageSentAccount("ev", eventAccount(payer, 1_760_000_000, REAL.message));
    expect(parsed).toEqual({ address: "ev", rentPayer: payer, createdAt: 1_760_000_000, message: REAL.message, lamports: 2_824_480 });
    expect(parseMessageSentAccount("ev", { ...eventAccount(payer, 1, REAL.message), owner: SPL_TOKEN_PROGRAM })).toBeNull();

    const ix = reclaimEventAccountInstruction({ payee: payer, eventAccount: "ev1111111111111111111111111111111111111111", message: REAL.message, attestation: REAL.attestation });
    expect(ix.keys.map((k) => [k.isSigner, k.isWritable])).toEqual([
      [true, true],
      [false, true],
      [false, true],
    ]);
    // Params in declaration order: attestation, then the destination message.
    expect(bytesToHex(ix.data)).toBe(
      concat([bytesToHex(RECLAIM_EVENT_ACCOUNT_DISCRIMINATOR), pad("0x82", { size: 4, dir: "right" }), REAL.attestation, pad("0x7801", { size: 4, dir: "right" }), REAL.message]),
    );
  });
});

/** A fake RPC: accounts by address, and fixed answers for the rest. */
function fakeRpc(accounts: Record<string, { owner: string; lamports: number; data: Uint8Array } | null>, sim: { err: unknown; logs?: string[] } = { err: null }) {
  const sent: { method: string; params: unknown[] }[] = [];
  const fetchImpl = (async (_url: string, init: { body: string }) => {
    const { method, params } = JSON.parse(init.body) as { method: string; params: unknown[] };
    sent.push({ method, params });
    const account = (a: string) => {
      const x = accounts[a];
      return x ? { owner: x.owner, lamports: x.lamports, data: [base64.encode(x.data), "base64"] } : null;
    };
    const result =
      method === "getAccountInfo"
        ? { value: account(params[0] as string) }
        : method === "getLatestBlockhash"
          ? { value: { blockhash: base58.encode(new Uint8Array(32).fill(9)), lastValidBlockHeight: 500 } }
          : method === "simulateTransaction"
            ? { value: { logs: [], unitsConsumed: 80_000, ...sim } }
            : method === "getRecentPrioritizationFees"
              ? []
              : method === "getMinimumBalanceForRentExemption"
                ? params[0] === 9
                  ? 953_520
                  : 2_039_280
                : null;
    return new Response(JSON.stringify({ result }));
  }) as unknown as typeof fetch;
  return { fetchImpl, sent };
}

describe("buildSolanaClaim", () => {
  const payer = Keypair.generate().publicKey.toBase58();
  const feeRecipient = Keypair.generate().publicKey.toBase58();
  const messenger = (() => {
    const data = new Uint8Array(200);
    data.set(base58.decode(feeRecipient), 109);
    return { owner: "CCTPV2vPZJS2u2BBsUoscuikbYjnpFmbFsvVuJdgUMQe", lamports: 1, data };
  })();
  const tokenAccount = (() => {
    const data = new Uint8Array(165);
    data.set(base58.decode(USDC), 0);
    data.set(base58.decode(REAL.owner), 32);
    return { owner: SPL_TOKEN_PROGRAM, lamports: 2_039_280, data };
  })();
  const nonce = usedNonceAddress(decodeMessage(REAL.message).nonce);
  const base = {
    AawthJCGRmggpfv9MMWV6Jmo9cue4gL9wUZgRBShg58W: messenger, // token_messenger PDA
    [solana.receiveLookupTable!]: tableAccount([...TABLE.addresses.slice(0, 10), associatedTokenAddress(feeRecipient, USDC), ...TABLE.addresses.slice(11)]),
    [nonce]: null,
  };

  it("finishes an undelivered transfer in one v0 transaction under the size limit", async () => {
    const { fetchImpl } = fakeRpc({ ...base, [REAL.tokenAccount]: tokenAccount });
    const plan = await buildSolanaClaim({ chain: solana, message: REAL.message, attestation: REAL.attestation, payer, fetchImpl });
    expect(plan.createsTokenAccount).toBe(false);
    expect(plan.transaction.length).toBeLessThanOrEqual(SOLANA_MAX_TRANSACTION_BYTES);
    const tx = VersionedTransaction.deserialize(plan.transaction);
    expect(tx.version).toBe(0);
    expect(tx.message.addressTableLookups[0]!.accountKey.toBase58()).toBe(solana.receiveLookupTable);
    expect(tx.message.staticAccountKeys[0]!.toBase58()).toBe(payer);
    expect(tx.message.compiledInstructions).toHaveLength(3);
    // One signature, the 10k-lamport priority floor (rounded up), the nonce account's rent.
    expect(plan.costLamports).toBe(5_000n + 10_001n + 953_520n);
  });

  it("opens a missing USDC account when it knows the owner, and says so otherwise", async () => {
    const hooked = concat([REAL.message, `0x${"ab".repeat(65)}`]); // the longest message ours make
    const { fetchImpl } = fakeRpc({ ...base, [REAL.tokenAccount]: null });
    await expect(buildSolanaClaim({ chain: solana, message: hooked, attestation: REAL.attestation, payer, fetchImpl })).rejects.toThrow(/no USDC account/);
    const plan = await buildSolanaClaim({ chain: solana, message: hooked, attestation: REAL.attestation, payer, owners: [payer, REAL.owner], fetchImpl });
    expect(plan.createsTokenAccount).toBe(true);
    expect(plan.transaction.length).toBeLessThanOrEqual(SOLANA_MAX_TRANSACTION_BYTES);
    expect(VersionedTransaction.deserialize(plan.transaction).message.compiledInstructions).toHaveLength(4);
    expect(plan.costLamports).toBe(5_000n + 10_001n + 953_520n + 2_039_280n);
  });

  it("refuses a delivered transfer, one pinned to someone else, and a claim without the table", async () => {
    const delivered = fakeRpc({ ...base, [nonce]: { owner: MT, lamports: 1, data: new Uint8Array(9) }, [REAL.tokenAccount]: tokenAccount });
    await expect(buildSolanaClaim({ chain: solana, message: REAL.message, attestation: REAL.attestation, payer, fetchImpl: delivered.fetchImpl })).rejects.toThrow(
      /already delivered/,
    );
    const other = Keypair.generate().publicKey.toBase58();
    const pinned = concat([hexToBytes(REAL.message).slice(0, 108), base58.decode(other), hexToBytes(REAL.message).slice(140)]);
    const { fetchImpl } = fakeRpc({ ...base, [REAL.tokenAccount]: tokenAccount });
    await expect(buildSolanaClaim({ chain: solana, message: bytesToHex(pinned), attestation: REAL.attestation, payer, fetchImpl })).rejects.toThrow(
      `Only ${other}`,
    );
    const noTable = fakeRpc({ ...base, [solana.receiveLookupTable!]: null, [REAL.tokenAccount]: tokenAccount });
    await expect(
      buildSolanaClaim({ chain: solana, message: REAL.message, attestation: REAL.attestation, payer, fetchImpl: noTable.fetchImpl }),
    ).rejects.toThrow(/lookup table/);
  });

  it("passes the program's refusal on", async () => {
    const { fetchImpl } = fakeRpc({ ...base, [REAL.tokenAccount]: tokenAccount }, { err: { InstructionError: [2, { Custom: 0 }] }, logs: ["Transfer: insufficient lamports 0, need 953520"] });
    await expect(buildSolanaClaim({ chain: solana, message: REAL.message, attestation: REAL.attestation, payer, fetchImpl })).rejects.toThrow(
      "Not enough SOL for the network fee",
    );
  });
});

describe("buildSolanaRefund", () => {
  const payee = Keypair.generate().publicKey.toBase58();
  const event = Keypair.generate().publicKey.toBase58();
  const created = 1_792_000_000;
  const after = () => (created + EVENT_ACCOUNT_REFUND_DELAY_SEC + 60) * 1000;

  it("returns the rent to the wallet that paid it", async () => {
    const { fetchImpl } = fakeRpc({ [event]: eventAccount(payee, created, REAL.message) });
    const plan = await buildSolanaRefund({ chain: solana, eventAccount: event, message: REAL.message, attestation: REAL.attestation, payee, fetchImpl, now: after });
    expect(plan.refundLamports).toBe(2_824_480n);
    expect(plan.costLamports).toBe(5_000n + 10_001n);
    const tx = VersionedTransaction.deserialize(plan.transaction);
    expect(tx.message.staticAccountKeys[0]!.toBase58()).toBe(payee);
    expect(size(bytesToHex(tx.message.compiledInstructions[2]!.data))).toBe(8 + 4 + 130 + 4 + 376);
  });

  it("waits out Circle's 5 days, and only the payer may take it", async () => {
    const { fetchImpl } = fakeRpc({ [event]: eventAccount(payee, created, REAL.message) });
    const opts = { chain: solana, eventAccount: event, message: REAL.message, attestation: REAL.attestation, fetchImpl };
    await expect(buildSolanaRefund({ ...opts, payee, now: () => (created + 3600) * 1000 })).rejects.toThrow(/refunded from/);
    await expect(buildSolanaRefund({ ...opts, payee: Keypair.generate().publicKey.toBase58(), now: after })).rejects.toThrow(`Only ${payee}`);
    const gone = fakeRpc({ [event]: null });
    await expect(buildSolanaRefund({ ...opts, payee, fetchImpl: gone.fetchImpl, now: after })).rejects.toThrow(/refunded already/);
  });
});

describe("Solana addresses in the claim", () => {
  it("names TokenMessengerMinter as the message recipient", () => {
    expect(decodeMessage(REAL.message).recipient).toBe(solanaToBytes32("CCTPV2vPZJS2u2BBsUoscuikbYjnpFmbFsvVuJdgUMQe"));
  });
});

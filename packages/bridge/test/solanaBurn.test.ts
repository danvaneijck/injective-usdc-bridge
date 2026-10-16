import { ed25519 } from "@noble/curves/ed25519";
import { base58, base64 } from "@scure/base";
import {
  ComputeBudgetProgram,
  Keypair,
  PublicKey,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import { getAddress, size, slice } from "viem";
import { describe, expect, it } from "vitest";
import { buildBurn } from "../src/burn.js";
import { chainByKey, injective, type SolanaChain } from "../src/chains.js";
import { BRIDGE_RECEIVER, ZERO_BYTES32 } from "../src/constants.js";
import { FORWARD_HOOK_DATA, forwardHookDataWithAccountSetup, forwardSetupOwner, isForwardHookData } from "../src/hookData.js";
import type { IrisClient } from "../src/iris.js";
import { type Quote, RouteError, quoteTransfer } from "../src/quote.js";
import {
  ASSOCIATED_TOKEN_PROGRAM,
  SPL_TOKEN_PROGRAM,
  associatedTokenAddress,
  checkSolanaRecipient,
  isWalletAddress,
  remoteTokenMessengerAddress,
  solanaToBytes32,
} from "../src/solana.js";
import {
  DEPOSIT_FOR_BURN_DISCRIMINATOR,
  DEPOSIT_FOR_BURN_WITH_HOOK_DISCRIMINATOR,
  SolanaSimulationError,
  buildSolanaBurn,
  compileLegacyMessage,
  computeBudgetInstructions,
  decodeSolanaBurn,
  depositForBurnInstruction,
  priorityMicroLamports,
  serializeTransaction,
  transactionSignature,
} from "../src/solanaBurn.js";

const solana = chainByKey("mainnet", "solana") as SolanaChain;
const inj = injective("mainnet");
const USDC = solana.usdcMint;

/**
 * Real mainnet burn, Solana -> Injective, 2 USDC, plain (slot 457551948,
 * 2026-10-16). Iris: destination 29, mintRecipient 0x21eb63b8…ce60, caller 0.
 */
const REAL = {
  signature: "CCAhCqB6higrveM1gQmNGzADJ33p7T7j8tsEHZD32EGXx1q7W5bEptbwzvJzjFzX6a9YkFr8HqUvoVtcVPzikbQ",
  data: "2H9Ja8XuEQY9i94xG2hZ8oXYAvbN8QAfLdPEKyjFgUxRxQ4qfDMJSV7XU5P5RzYrNjuBBrEywDLpUXr8eZbCNyVejm7G9UiQLfoLQGkjhbqJAa4UvnxHrcbv444pzcaSVV6X",
  owner: "CeeVcSmNej5z8zKaaoX4TUG1su7i3vPHut52vViNdeBi",
  eventAccount: "2F5eMVcS3XsYZqjtkfDnbc7AxMzPzZdR2TSAj16goBZp",
  accounts:
    "CeeVcSmNej5z8zKaaoX4TUG1su7i3vPHut52vViNdeBi,CeeVcSmNej5z8zKaaoX4TUG1su7i3vPHut52vViNdeBi,45hzrGLQ2EGo1Ln7QpXjDwb589GDQ9H2aEXXw6ds6BFE,5NhytzwGCMAAYwgJZr1yJpaSYVqUQttWHGu3MpV4o38n,WDCnvMMs2g9mqYeFAMq3NfnAE6bs5vJ5BoQXR8axnnG,W1k5ijkaSTo5iA5zChNpfzcy796fLhkBxfmJuR8W8HU,AawthJCGRmggpfv9MMWV6Jmo9cue4gL9wUZgRBShg58W,2tFfjwfzfzBrfftSrbsC5L3PmCtvkNfLLyXDTA7KYvng,E1bQJ8eMMn3zmeSewW3HQ8zmJr7KR75JonbwAtWx2bux,CRBBbuLCyrkQy4dCTHxqstSmDQv4ajBeUVb9qUdMVaP1,EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v,2F5eMVcS3XsYZqjtkfDnbc7AxMzPzZdR2TSAj16goBZp,CCTPV2Sm4AdWt5296sk4P66VBZ7bEhcARwFaaS9YPbeC,CCTPV2vPZJS2u2BBsUoscuikbYjnpFmbFsvVuJdgUMQe,TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA,11111111111111111111111111111111,6TCCnJ9R1m1RXFzyoH7GYH2J6NJDtZaUvfipPuLWxHNd,CCTPV2vPZJS2u2BBsUoscuikbYjnpFmbFsvVuJdgUMQe".split(
      ",",
    ),
};

const EVM_RECIPIENT = getAddress("0x21eb63b81d92ca293470e643a124607e4ff1ce60");

describe("Solana burn instruction", () => {
  it("uses Anchor's discriminators (the ones v1 has shipped since August)", () => {
    expect([...DEPOSIT_FOR_BURN_DISCRIMINATOR]).toEqual([0xd7, 0x3c, 0x3d, 0x2e, 0x72, 0x37, 0x80, 0xb0]);
    expect([...DEPOSIT_FOR_BURN_WITH_HOOK_DISCRIMINATOR]).toEqual([0x6f, 0xf5, 0x3e, 0x83, 0xcc, 0x6c, 0xdf, 0x9b]);
  });

  it("decodes a real mainnet burn to Injective and rebuilds it byte for byte", () => {
    const data = base58.decode(REAL.data);
    const d = decodeSolanaBurn(data)!;
    expect(d).toMatchObject({
      withHook: false,
      amount: 2_000_000n,
      destinationDomain: 29,
      destinationCaller: ZERO_BYTES32,
      minFinalityThreshold: 2000,
      hookData: "0x",
    });
    expect(d.mintRecipient).toBe(`0x000000000000000000000000${EVM_RECIPIENT.slice(2).toLowerCase()}`);
    const ix = depositForBurnInstruction({
      owner: REAL.owner,
      mint: USDC,
      messageSentEventData: REAL.eventAccount,
      args: { ...d, hookData: undefined },
    });
    expect(ix.keys.map((k) => k.pubkey)).toEqual(REAL.accounts);
    expect(base58.encode(ix.data)).toBe(REAL.data);
  });

  it("round-trips the hooked variant", () => {
    const hookData = forwardHookDataWithAccountSetup(solanaToBytes32(REAL.owner));
    const ix = depositForBurnInstruction({
      owner: REAL.owner,
      mint: USDC,
      messageSentEventData: REAL.eventAccount,
      args: { amount: 5n, destinationDomain: 29, mintRecipient: ZERO_BYTES32, destinationCaller: ZERO_BYTES32, maxFee: 1n, minFinalityThreshold: 1000, hookData },
    });
    expect(decodeSolanaBurn(ix.data)).toMatchObject({ withHook: true, amount: 5n, maxFee: 1n, hookData });
    expect(decodeSolanaBurn(new Uint8Array(120))).toBeNull();
  });

  it("indexes burns to Injective through one account", () => {
    expect(remoteTokenMessengerAddress(29)).toBe("2tFfjwfzfzBrfftSrbsC5L3PmCtvkNfLLyXDTA7KYvng");
  });
});

describe("Solana transaction bytes", () => {
  it("compile and serialise exactly as @solana/web3.js does", () => {
    const owner = Keypair.generate();
    const event = Keypair.generate();
    const blockhash = base58.encode(new Uint8Array(32).fill(7));
    const burn = depositForBurnInstruction({
      owner: owner.publicKey.toBase58(),
      mint: USDC,
      messageSentEventData: event.publicKey.toBase58(),
      args: { amount: 1_000_000n, destinationDomain: 29, mintRecipient: solanaToBytes32(REAL.owner), destinationCaller: ZERO_BYTES32, maxFee: 100n, minFinalityThreshold: 1000 },
    });
    const ours = [...computeBudgetInstructions(73_000, 1_234), burn];
    const message = compileLegacyMessage(owner.publicKey.toBase58(), ours, blockhash);

    const theirs = new TransactionMessage({
      payerKey: owner.publicKey,
      recentBlockhash: blockhash,
      instructions: [
        ComputeBudgetProgram.setComputeUnitLimit({ units: 73_000 }),
        ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1_234 }),
        new TransactionInstruction({
          programId: new PublicKey(burn.programId),
          keys: burn.keys.map((k) => ({ ...k, pubkey: new PublicKey(k.pubkey) })),
          data: Buffer.from(burn.data),
        }),
      ],
    }).compileToLegacyMessage();
    expect([...message.bytes]).toEqual([...theirs.serialize()]);

    const tx = new VersionedTransaction(theirs);
    tx.sign([owner, event]);
    const wire = serializeTransaction(
      message,
      new Map([
        [owner.publicKey.toBase58(), ed25519.sign(message.bytes, owner.secretKey.slice(0, 32))],
        [event.publicKey.toBase58(), ed25519.sign(message.bytes, event.secretKey.slice(0, 32))],
      ]),
    );
    expect([...wire]).toEqual([...tx.serialize()]);
    expect(transactionSignature(wire)).toBe(base58.encode(tx.signatures[0]!));
  });

  it("derives associated token accounts like the token program", () => {
    const [ata] = PublicKey.findProgramAddressSync(
      [new PublicKey(REAL.owner).toBuffer(), new PublicKey(SPL_TOKEN_PROGRAM).toBuffer(), new PublicKey(USDC).toBuffer()],
      new PublicKey(ASSOCIATED_TOKEN_PROGRAM),
    );
    expect(associatedTokenAddress(REAL.owner, USDC)).toBe(ata.toBase58());
    // The real burn spent from exactly this account.
    expect(ata.toBase58()).toBe(REAL.accounts[3]);
  });

  it("tells wallets from token accounts", () => {
    expect(isWalletAddress(REAL.owner)).toBe(true);
    expect(isWalletAddress(associatedTokenAddress(REAL.owner, USDC))).toBe(false);
    expect(isWalletAddress("not base58 0OIl")).toBe(false);
  });

  it("keeps the priority fee between its bounds", () => {
    // At 100k compute units: 10k lamports floor = 100k micro-lamports a unit, 200k ceiling = 2M.
    expect(priorityMicroLamports([], 100_000)).toBe(100_000);
    expect(priorityMicroLamports([5, 10, 50_000, 9_000_000], 100_000)).toBe(2_000_000);
    expect(priorityMicroLamports([200_000, 300_000, 400_000, 500_000], 100_000)).toBe(500_000);
  });
});

describe("forwarding to Solana", () => {
  const owner = solanaToBytes32(REAL.owner);

  it("asks Circle to create the USDC account with the documented layout", () => {
    const hook = forwardHookDataWithAccountSetup(owner);
    expect(size(hook)).toBe(65);
    expect(isForwardHookData(hook)).toBe(true);
    expect(slice(hook, 24, 28)).toBe("0x00000000");
    expect(slice(hook, 28, 32)).toBe("0x00000021");
    expect(slice(hook, 32, 33)).toBe("0x01");
    expect(forwardSetupOwner(hook)).toBe(owner);
    expect(forwardSetupOwner(FORWARD_HOOK_DATA)).toBeNull();
  });

  const iris = (forward: number) =>
    ({
      getFees: async (_s: number, _d: number, o: { recipientSetup?: boolean }) => [
        { finalityThreshold: 2000, minimumFee: 0, forwardFee: { low: forward, med: o.recipientSetup ? forward * 2 : forward, high: forward } },
      ],
    }) as unknown as IrisClient;

  it("burns to the owner's USDC account, never the wallet", async () => {
    const quote = await quoteTransfer({ iris: iris(130_000), route: { source: inj, destination: solana }, amount: 10_000_000n });
    const plan = buildBurn({ network: "mainnet", route: { source: inj, destination: solana }, quote, recipient: REAL.owner });
    expect(plan.mintRecipient).toBe(solanaToBytes32(associatedTokenAddress(REAL.owner, USDC)));
    expect(plan.hookData).toBe(FORWARD_HOOK_DATA);
    expect(plan.destinationCaller).toBe(ZERO_BYTES32);
  });

  it("adds account setup, and its fee, when the recipient has no USDC account", async () => {
    const quote = await quoteTransfer({ iris: iris(130_000), route: { source: inj, destination: solana }, amount: 10_000_000n, recipientSetup: true });
    expect(quote.forwardingFee).toBe(260_000n);
    const plan = buildBurn({ network: "mainnet", route: { source: inj, destination: solana }, quote, recipient: REAL.owner });
    expect(forwardSetupOwner(plan.hookData)).toBe(owner);
  });

  it("refuses a token account typed where the wallet belongs", async () => {
    const quote = await quoteTransfer({ iris: iris(130_000), route: { source: inj, destination: solana }, amount: 10_000_000n });
    const ata = associatedTokenAddress(REAL.owner, USDC);
    expect(() => buildBurn({ network: "mainnet", route: { source: inj, destination: solana }, quote, recipient: ata })).toThrow(RouteError);
    expect(() =>
      buildBurn({ network: "mainnet", route: { source: inj, destination: solana }, quote: { ...quote, forwarded: false }, recipient: REAL.owner }),
    ).toThrow(/forwarding/);
  });

  it("checks a typed recipient on chain", async () => {
    const ata = associatedTokenAddress(REAL.owner, USDC);
    const accounts: Record<string, { owner: string } | null> = { [REAL.owner]: null, [ata]: { owner: SPL_TOKEN_PROGRAM } };
    const fetchImpl = (async (_url: string, init: { body: string }) => {
      const { params } = JSON.parse(init.body) as { params: [string] };
      const a = accounts[params[0]] ?? null;
      return new Response(JSON.stringify({ result: { value: a ? { ...a, lamports: 1, data: [base64.encode(new Uint8Array(165)), "base64"] } : null } }));
    }) as unknown as typeof fetch;
    expect(await checkSolanaRecipient(["x"], REAL.owner, USDC, fetchImpl)).toEqual({ ok: true, tokenAccount: ata, tokenAccountExists: true });
    expect(await checkSolanaRecipient(["x"], ata, USDC, fetchImpl)).toEqual({ ok: false, reason: "token_account" });
    expect(await checkSolanaRecipient(["x"], "0x123", USDC, fetchImpl)).toEqual({ ok: false, reason: "not_an_address" });
  });
});

describe("buildSolanaBurn", () => {
  const quote: Quote = {
    direction: "deposit",
    amount: 1_000_000n,
    speed: "fast",
    minFinalityThreshold: 1000,
    protocolFee: 120n,
    forwardingFee: 0n,
    gasDropFee: 0n,
    bridgeFee: 0n,
    maxFee: 120n,
    minReceived: 999_880n,
    forwarded: false,
    recipientSetup: false,
  };
  const owner = Keypair.generate().publicKey.toBase58();

  function rpc(sim: { err: unknown; logs?: string[]; unitsConsumed?: number }) {
    const calls: string[] = [];
    const fetchImpl = (async (_url: string, init: { body: string }) => {
      const { method } = JSON.parse(init.body) as { method: string };
      calls.push(method);
      const result =
        method === "getLatestBlockhash"
          ? { value: { blockhash: base58.encode(new Uint8Array(32).fill(9)), lastValidBlockHeight: 1_000 } }
          : method === "simulateTransaction"
            ? { value: { logs: [], ...sim } }
            : method === "getRecentPrioritizationFees"
              ? [{ prioritizationFee: 1_000 }]
              : method === "getMinimumBalanceForRentExemption"
                ? 3_869_760
                : null;
      return new Response(JSON.stringify({ result }));
    }) as unknown as typeof fetch;
    return { fetchImpl, calls };
  }

  it("simulates, sizes compute, and leaves only the owner's signature to add", async () => {
    const { fetchImpl } = rpc({ err: null, unitsConsumed: 60_000 });
    const eventKey = ed25519.utils.randomPrivateKey();
    const plan = await buildSolanaBurn({ route: { source: solana, destination: inj }, quote, owner, recipient: EVM_RECIPIENT, fetchImpl, eventKey });
    const tx = VersionedTransaction.deserialize(plan.transaction);
    expect(tx.message.staticAccountKeys[0]!.toBase58()).toBe(owner);
    expect(tx.signatures[0]!.every((b) => b === 0)).toBe(true);
    expect(ed25519.verify(tx.signatures[1]!, tx.message.serialize(), base58.decode(plan.eventAccount))).toBe(true);
    const ixs = tx.message.compiledInstructions;
    expect(new DataView(ixs[0]!.data.buffer, ixs[0]!.data.byteOffset).getUint32(1, true)).toBe(73_000);
    const burn = decodeSolanaBurn(ixs[2]!.data)!;
    expect(burn).toMatchObject({ amount: 1_000_000n, destinationDomain: 29, maxFee: 120n, minFinalityThreshold: 1000, withHook: false });
    // Two signatures, the 10k-lamport priority floor (rounded up), the event account's rent.
    expect(plan.costLamports).toBe(10_000n + 10_001n + 3_869_760n);
  });

  it("pins a gas-drop burn to BridgeReceiver with the recipient in the hook", async () => {
    const { fetchImpl } = rpc({ err: null, unitsConsumed: 70_000 });
    const receiver = BRIDGE_RECEIVER.mainnet!;
    const plan = await buildSolanaBurn({
      route: { source: solana, destination: inj },
      quote: { ...quote, gasDropFee: 500_000n },
      owner,
      recipient: EVM_RECIPIENT,
      gasDrop: { receiver, maxDropFee: 500_000n },
      fetchImpl,
    });
    const burn = decodeSolanaBurn(VersionedTransaction.deserialize(plan.transaction).message.compiledInstructions[2]!.data)!;
    expect(burn.withHook).toBe(true);
    expect(burn.mintRecipient).toBe(burn.destinationCaller);
    expect(burn.destinationCaller).toBe(`0x000000000000000000000000${receiver.slice(2).toLowerCase()}`);
    expect(size(burn.hookData)).toBe(96);
  });

  it("refuses a burn the program would reject, with its reason", async () => {
    const { fetchImpl } = rpc({ err: { InstructionError: [2, { Custom: 1 }] }, logs: ["Program log: Error: insufficient funds"] });
    await expect(
      buildSolanaBurn({ route: { source: solana, destination: inj }, quote, owner, recipient: EVM_RECIPIENT, fetchImpl }),
    ).rejects.toThrow(new SolanaSimulationError({}, ["insufficient funds"]).message);
  });
});

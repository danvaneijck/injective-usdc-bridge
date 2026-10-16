import {
  type Address,
  type Hex,
  concat,
  encodeAbiParameters,
  encodeEventTopics,
  getAddress,
  numberToHex,
  pad,
} from "viem";
import {
  CCTP_CONTRACTS,
  type IrisClient,
  type IrisMessage,
  ZERO_BYTES32,
  addressToBytes32,
  tokenMessengerV2Abi,
} from "injective-usdc-bridge";
import { Store } from "../src/db.js";

export const USER = getAddress("0x73fcb2d05f2e29561b58177af7f22ac19b3b484f");
export const OTHER = getAddress("0x00000000000000000000000000000000000a11ce");
export const RECEIVER = getAddress("0x00000000000000000000000000000000000b1d9e");
export const LEGACY = getAddress("0xbe7ad6bd72585fe0d38ffb16db0e00f085a754b4");
export const BASE_USDC = getAddress("0x833589fcd6edb6e08f4c7c32d4f71b54bda02913");

export function memStore(): Store {
  return new Store(":memory:");
}

export interface BurnSpec {
  amount?: bigint;
  depositor?: Address;
  mintRecipient?: Hex;
  destinationDomain?: number;
  destinationCaller?: Hex;
  maxFee?: bigint;
  minFinality?: number;
  hookData?: Hex;
}

/** A raw DepositForBurn log as eth_getLogs returns it. */
export function burnLog(spec: BurnSpec & { blockNumber?: bigint; txHash?: Hex; logIndex?: number }) {
  const topics = encodeEventTopics({
    abi: tokenMessengerV2Abi,
    eventName: "DepositForBurn",
    args: {
      burnToken: BASE_USDC,
      depositor: spec.depositor ?? USER,
      minFinalityThreshold: spec.minFinality ?? 2000,
    },
  });
  const data = encodeAbiParameters(
    [
      { type: "uint256" },
      { type: "bytes32" },
      { type: "uint32" },
      { type: "bytes32" },
      { type: "bytes32" },
      { type: "uint256" },
      { type: "bytes" },
    ],
    [
      spec.amount ?? 10_000_000n,
      spec.mintRecipient ?? addressToBytes32(USER),
      spec.destinationDomain ?? 29,
      addressToBytes32(CCTP_CONTRACTS.mainnet.tokenMessenger),
      spec.destinationCaller ?? ZERO_BYTES32,
      spec.maxFee ?? 0n,
      spec.hookData ?? "0x",
    ],
  );
  return {
    address: CCTP_CONTRACTS.mainnet.tokenMessenger.toLowerCase() as Address,
    topics: topics as [Hex, ...Hex[]],
    data,
    blockNumber: spec.blockNumber ?? 100n,
    transactionHash: spec.txHash ?? (`0x${"aa".repeat(32)}` as Hex),
    logIndex: spec.logIndex ?? 0,
  };
}

/** An attested CCTP V2 burn message with the real byte layout. */
export function attestedMessage(spec: {
  src: number;
  dst: number;
  nonce: Hex;
  mintRecipient: Hex;
  amount: bigint;
  destinationCaller?: Hex;
  feeExecuted?: bigint;
  expirationBlock?: bigint;
  hookData?: Hex;
}): IrisMessage {
  const u32 = (n: number) => numberToHex(n, { size: 4 });
  const u256 = (n: bigint) => numberToHex(n, { size: 32 });
  const header = concat([
    u32(1),
    u32(spec.src),
    u32(spec.dst),
    spec.nonce,
    pad(CCTP_CONTRACTS.mainnet.tokenMessenger, { size: 32 }),
    pad(CCTP_CONTRACTS.mainnet.tokenMessenger, { size: 32 }),
    spec.destinationCaller ?? ZERO_BYTES32,
    u32(2000),
    u32(2000),
  ]);
  const body = concat([
    u32(1),
    pad(BASE_USDC, { size: 32 }),
    spec.mintRecipient,
    u256(spec.amount),
    addressToBytes32(USER),
    u256(0n),
    u256(spec.feeExecuted ?? 0n),
    u256(spec.expirationBlock ?? 0n),
    spec.hookData ?? "0x",
  ]);
  return {
    message: concat([header, body]),
    eventNonce: spec.nonce,
    attestation: "0x1234",
    cctpVersion: 2,
    status: "complete",
    delayReason: null,
  };
}

export function fakeIris(byTx: Record<string, IrisMessage[]>, calls: string[] = []): IrisClient {
  return {
    getMessages: async (_d: number, tx: string) => {
      calls.push(`get:${tx}`);
      return byTx[tx.toLowerCase()] ?? [];
    },
    reattest: async (nonce: string) => {
      calls.push(`reattest:${nonce}`);
    },
    getFees: async () => [],
  } as unknown as IrisClient;
}

export const noLimit = { take: async () => {} } as never;

export class Clock {
  constructor(public t = 1_800_000_000_000) {}
  now = () => this.t;
  advance(ms: number) {
    this.t += ms;
  }
}

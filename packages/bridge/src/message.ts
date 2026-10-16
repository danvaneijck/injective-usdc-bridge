import {
  type Address,
  type Hex,
  getAddress,
  hexToBigInt,
  hexToNumber,
  pad,
  size,
  slice,
} from "viem";
import { ZERO_BYTES32 } from "./constants.js";

/**
 * CCTP V2 message header. Byte offsets:
 * version 0-4, sourceDomain 4-8, destinationDomain 8-12, nonce 12-44,
 * sender 44-76, recipient 76-108, destinationCaller 108-140,
 * minFinalityThreshold 140-144, finalityThresholdExecuted 144-148, body 148-.
 *
 * The nonce inside a MessageSent log is all zeros: Iris assigns the real
 * eventNonce at attestation, so only an attested message carries one.
 */
export interface CctpMessage {
  version: number;
  sourceDomain: number;
  destinationDomain: number;
  nonce: Hex;
  sender: Hex;
  recipient: Hex;
  destinationCaller: Hex;
  minFinalityThreshold: number;
  finalityThresholdExecuted: number;
  body: Hex;
}

/**
 * BurnMessageV2 body. It starts with its own 4-byte version; forgetting it
 * shifts every field and addresses render as `0x00000000a00c59ff…`.
 * version 0-4, burnToken 4-36, mintRecipient 36-68, amount 68-100,
 * messageSender 100-132, maxFee 132-164, feeExecuted 164-196,
 * expirationBlock 196-228, hookData 228-.
 */
export interface BurnMessage {
  version: number;
  burnToken: Hex;
  mintRecipient: Hex;
  amount: bigint;
  messageSender: Hex;
  maxFee: bigint;
  feeExecuted: bigint;
  expirationBlock: bigint;
  hookData: Hex;
}

const HEADER_BYTES = 148;
const BURN_BODY_BYTES = 228;

export function decodeMessage(message: Hex): CctpMessage {
  if (size(message) < HEADER_BYTES) {
    throw new Error(`CCTP message too short: ${size(message)} bytes`);
  }
  return {
    version: hexToNumber(slice(message, 0, 4)),
    sourceDomain: hexToNumber(slice(message, 4, 8)),
    destinationDomain: hexToNumber(slice(message, 8, 12)),
    nonce: slice(message, 12, 44),
    sender: slice(message, 44, 76),
    recipient: slice(message, 76, 108),
    destinationCaller: slice(message, 108, 140),
    minFinalityThreshold: hexToNumber(slice(message, 140, 144)),
    finalityThresholdExecuted: hexToNumber(slice(message, 144, 148)),
    body: size(message) === HEADER_BYTES ? "0x" : slice(message, HEADER_BYTES),
  };
}

export function decodeBurnMessage(body: Hex): BurnMessage {
  if (size(body) < BURN_BODY_BYTES) {
    throw new Error(`Burn message body too short: ${size(body)} bytes`);
  }
  return {
    version: hexToNumber(slice(body, 0, 4)),
    burnToken: slice(body, 4, 36),
    mintRecipient: slice(body, 36, 68),
    amount: hexToBigInt(slice(body, 68, 100)),
    messageSender: slice(body, 100, 132),
    maxFee: hexToBigInt(slice(body, 132, 164)),
    feeExecuted: hexToBigInt(slice(body, 164, 196)),
    expirationBlock: hexToBigInt(slice(body, 196, 228)),
    hookData: size(body) === BURN_BODY_BYTES ? "0x" : slice(body, BURN_BODY_BYTES),
  };
}

export function addressToBytes32(address: Address): Hex {
  return pad(getAddress(address), { size: 32 }).toLowerCase() as Hex;
}

/** EVM view of a bytes32 field. Throws if the upper 12 bytes are not zero. */
export function bytes32ToAddress(value: Hex): Address {
  if (size(value) !== 32) throw new Error(`Expected bytes32, got ${size(value)} bytes`);
  if (hexToBigInt(slice(value, 0, 12)) !== 0n) {
    throw new Error(`bytes32 ${value} is not an EVM address`);
  }
  return getAddress(slice(value, 12, 32));
}

/**
 * True when anyone may submit the mint. A set destinationCaller means only that
 * address can call receiveMessage, so the user cannot self-rescue and Circle's
 * Forwarding Service will not touch it.
 */
export function isPermissionless(message: CctpMessage): boolean {
  return message.destinationCaller.toLowerCase() === ZERO_BYTES32;
}

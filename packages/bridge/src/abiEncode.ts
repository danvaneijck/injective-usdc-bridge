import { type Hex, concat, getAddress, keccak256, numberToHex, size, stringToHex } from "./hex.js";

/**
 * Calldata for the few calls the core builds (ERC20 approve, the two
 * TokenMessengerV2 burns, MessageTransmitterV2.receiveMessage) and the
 * gas-drop hook, written out rather than taken from a general ABI encoder.
 * test/abiEncode.test.ts compares each against viem's encodeFunctionData.
 */
export type AbiArg =
  | { type: "uint"; bits: 8 | 32 | 256; value: bigint | number }
  | { type: "address"; value: string }
  | { type: "bytes32"; value: Hex }
  | { type: "bytes4"; value: Hex }
  | { type: "bytes"; value: Hex };

/** The 4-byte selector of a canonical signature such as `approve(address,uint256)`. */
export function selector(signature: string): Hex {
  return keccak256(stringToHex(signature)).slice(0, 10) as Hex;
}

function word(arg: Exclude<AbiArg, { type: "bytes" }>): Hex {
  switch (arg.type) {
    case "uint": {
      const v = BigInt(arg.value);
      if (v < 0n || v >= 1n << BigInt(arg.bits)) throw new Error(`${arg.value} is not a uint${arg.bits}`);
      return numberToHex(v, 32);
    }
    case "address":
      return `0x${getAddress(arg.value).slice(2).toLowerCase().padStart(64, "0")}`;
    case "bytes32":
      if (size(arg.value) !== 32) throw new Error(`Expected 32 bytes, got ${size(arg.value)}`);
      return arg.value.toLowerCase() as Hex;
    case "bytes4":
      if (size(arg.value) !== 4) throw new Error(`Expected 4 bytes, got ${size(arg.value)}`);
      return `0x${arg.value.slice(2).toLowerCase().padEnd(64, "0")}`;
  }
}

/** abi.encode(args): static words in place, each `bytes` as an offset with its data in the tail. */
export function encodeArgs(args: readonly AbiArg[]): Hex {
  const head: Hex[] = [];
  const tail: Hex[] = [];
  let tailBytes = args.length * 32;
  for (const a of args) {
    if (a.type !== "bytes") {
      head.push(word(a));
      continue;
    }
    head.push(numberToHex(tailBytes, 32));
    const n = size(a.value);
    const padded = `0x${a.value.slice(2).toLowerCase().padEnd(Math.ceil(n / 32) * 64, "0")}` as Hex;
    tail.push(numberToHex(n, 32), padded);
    tailBytes += 32 + size(padded);
  }
  return concat([...head, ...tail]);
}

export function encodeCall(signature: string, args: readonly AbiArg[]): Hex {
  return concat([selector(signature), encodeArgs(args)]);
}

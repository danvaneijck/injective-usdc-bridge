/**
 * The ABIs as plain JSON, `as const`: viem types its reads against them as it
 * did against `parseAbi`, and the core needs no viem to hold them.
 * test/abiEncode.test.ts checks them against `parseAbi` of the signatures.
 */

export const tokenMessengerV2Abi = [
  { name: "depositForBurn", type: "function", stateMutability: "nonpayable", inputs: [{ type: "uint256", name: "amount" }, { type: "uint32", name: "destinationDomain" }, { type: "bytes32", name: "mintRecipient" }, { type: "address", name: "burnToken" }, { type: "bytes32", name: "destinationCaller" }, { type: "uint256", name: "maxFee" }, { type: "uint32", name: "minFinalityThreshold" }], outputs: [] },
  { name: "depositForBurnWithHook", type: "function", stateMutability: "nonpayable", inputs: [{ type: "uint256", name: "amount" }, { type: "uint32", name: "destinationDomain" }, { type: "bytes32", name: "mintRecipient" }, { type: "address", name: "burnToken" }, { type: "bytes32", name: "destinationCaller" }, { type: "uint256", name: "maxFee" }, { type: "uint32", name: "minFinalityThreshold" }, { type: "bytes", name: "hookData" }], outputs: [] },
  { name: "DepositForBurn", type: "event", inputs: [{ type: "address", name: "burnToken", indexed: true }, { type: "uint256", name: "amount" }, { type: "address", name: "depositor", indexed: true }, { type: "bytes32", name: "mintRecipient" }, { type: "uint32", name: "destinationDomain" }, { type: "bytes32", name: "destinationTokenMessenger" }, { type: "bytes32", name: "destinationCaller" }, { type: "uint256", name: "maxFee" }, { type: "uint32", name: "minFinalityThreshold", indexed: true }, { type: "bytes", name: "hookData" }] },
] as const;

export const messageTransmitterV2Abi = [
  { name: "receiveMessage", type: "function", stateMutability: "nonpayable", inputs: [{ type: "bytes", name: "message" }, { type: "bytes", name: "attestation" }], outputs: [{ type: "bool" }] },
  { name: "usedNonces", type: "function", stateMutability: "view", inputs: [{ type: "bytes32", name: "nonce" }], outputs: [{ type: "uint256" }] },
  { name: "localDomain", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "uint32" }] },
  { name: "MessageSent", type: "event", inputs: [{ type: "bytes", name: "message" }] },
  { name: "MessageReceived", type: "event", inputs: [{ type: "address", name: "caller", indexed: true }, { type: "uint32", name: "sourceDomain" }, { type: "bytes32", name: "nonce", indexed: true }, { type: "bytes32", name: "sender" }, { type: "uint32", name: "finalityThresholdExecuted", indexed: true }, { type: "bytes", name: "messageBody" }] },
] as const;

export const erc20Abi = [
  { name: "balanceOf", type: "function", stateMutability: "view", inputs: [{ type: "address", name: "owner" }], outputs: [{ type: "uint256" }] },
  { name: "allowance", type: "function", stateMutability: "view", inputs: [{ type: "address", name: "owner" }, { type: "address", name: "spender" }], outputs: [{ type: "uint256" }] },
  { name: "approve", type: "function", stateMutability: "nonpayable", inputs: [{ type: "address", name: "spender" }, { type: "uint256", name: "amount" }], outputs: [{ type: "bool" }] },
  { name: "decimals", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] },
  { name: "symbol", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
] as const;

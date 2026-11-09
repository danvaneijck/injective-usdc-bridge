import { encodeCall } from "./abiEncode.js";
import { CCTP_CONTRACTS, type Network, ZERO_BYTES32 } from "./constants.js";
import { encodeGasDropHook } from "./gasDrop.js";
import { type Address, type Hex, isAddress } from "./hex.js";
import { FORWARD_HOOK_DATA, forwardHookDataWithAccountSetup } from "./hookData.js";
import { addressToBytes32 } from "./message.js";
import { type Quote, type Route, RouteError, routeDirection } from "./quote.js";
import { associatedTokenAddress, isWalletAddress, solanaToBytes32 } from "./solana.js";

export interface EvmCall {
  to: Address;
  data: Hex;
  value: bigint;
}

export interface BurnPlan {
  /** Present when the current allowance is below the amount. */
  approve?: EvmCall;
  burn: EvmCall;
  spender: Address;
  mintRecipient: Hex;
  destinationCaller: Hex;
  hookData: Hex;
}

export interface BuildBurnOptions {
  network: Network;
  route: Route;
  quote: Quote;
  /**
   * Who receives the USDC: an EVM address, or for Solana the owner's wallet
   * address (the burn names that wallet's USDC account, never the wallet).
   */
  recipient: string;
  /** Current USDC allowance of the TokenMessenger; omit to always approve. */
  allowance?: bigint;
  /**
   * Deposits only: route the mint through BridgeReceiver so the user also
   * gets INJ for gas. `maxDropFee` is the most the user agreed to pay.
   */
  gasDrop?: { receiver: Address; maxDropFee: bigint };
}

/**
 * Builds the approve + burn for one transfer. Every burn can be completed by
 * anyone: plain burns leave destinationCaller at 0, and gas-drop burns pin it
 * to BridgeReceiver, whose relay() is itself permissionless. v1 pinned burns
 * to a contract users could not drive, which made them impossible to
 * self-rescue.
 */
export function buildBurn(opts: BuildBurnOptions): BurnPlan {
  if (opts.gasDrop) return buildGasDropBurn(opts, opts.gasDrop);
  const { route, quote, network } = opts;
  if (route.source.kind !== "evm") {
    throw new RouteError(`${route.source.name} burns are not supported yet`);
  }
  if (routeDirection(route) !== quote.direction) {
    throw new RouteError("Quote was made for a different route");
  }

  let mintRecipient: Hex;
  let hookData: Hex;
  if (route.destination.kind === "solana") {
    // With forwarding Circle delivers on Solana. Without it the recipient
    // claims there (buildSolanaClaim), which takes SOL; the widget always
    // forwards.
    if (!isWalletAddress(opts.recipient)) {
      throw new RouteError(`Recipient ${opts.recipient} is not a Solana wallet address`);
    }
    const owner = opts.recipient.trim();
    mintRecipient = solanaToBytes32(associatedTokenAddress(owner, route.destination.usdcMint));
    hookData = !quote.forwarded ? "0x" : quote.recipientSetup ? forwardHookDataWithAccountSetup(solanaToBytes32(owner)) : FORWARD_HOOK_DATA;
  } else {
    if (!isAddress(opts.recipient)) {
      throw new RouteError(`Recipient ${opts.recipient} is not an EVM address`);
    }
    mintRecipient = addressToBytes32(opts.recipient);
    hookData = quote.forwarded ? FORWARD_HOOK_DATA : "0x";
  }

  const { tokenMessenger } = CCTP_CONTRACTS[network];
  const destinationCaller = ZERO_BYTES32;

  const data = burnCall({
    amount: quote.amount,
    destinationDomain: route.destination.domain,
    mintRecipient,
    burnToken: route.source.usdc,
    destinationCaller,
    maxFee: quote.maxFee,
    minFinalityThreshold: quote.minFinalityThreshold,
    hookData: quote.forwarded ? hookData : undefined,
  });

  return {
    approve: approveCall(route.source.usdc, tokenMessenger, quote.amount, opts.allowance),
    burn: { to: tokenMessenger, data, value: 0n },
    spender: tokenMessenger,
    mintRecipient,
    destinationCaller,
    hookData,
  };
}

function buildGasDropBurn(
  opts: BuildBurnOptions,
  gasDrop: { receiver: Address; maxDropFee: bigint },
): BurnPlan {
  const { route, quote, network } = opts;
  if (quote.direction !== "deposit" || routeDirection(route) !== "deposit") {
    throw new RouteError("Gas drop is only available on deposits to Injective");
  }
  if (route.source.kind !== "evm") {
    throw new RouteError(`${route.source.name} burns are not supported yet`);
  }
  if (!isAddress(opts.recipient)) {
    throw new RouteError(`Recipient ${opts.recipient} is not an EVM address`);
  }
  if (!isAddress(gasDrop.receiver)) {
    throw new RouteError(`Gas drop receiver ${gasDrop.receiver} is not an EVM address`);
  }
  const { tokenMessenger } = CCTP_CONTRACTS[network];
  const receiver = addressToBytes32(gasDrop.receiver);
  const hookData = encodeGasDropHook(opts.recipient, gasDrop.maxDropFee);
  const data = burnCall({
    amount: quote.amount,
    destinationDomain: route.destination.domain,
    mintRecipient: receiver,
    burnToken: route.source.usdc,
    destinationCaller: receiver,
    maxFee: quote.maxFee,
    minFinalityThreshold: quote.minFinalityThreshold,
    hookData,
  });
  return {
    approve: approveCall(route.source.usdc, tokenMessenger, quote.amount, opts.allowance),
    burn: { to: tokenMessenger, data, value: 0n },
    spender: tokenMessenger,
    mintRecipient: receiver,
    destinationCaller: receiver,
    hookData,
  };
}

function approveCall(
  usdc: Address,
  spender: Address,
  amount: bigint,
  allowance: bigint | undefined,
): EvmCall | undefined {
  if (allowance !== undefined && allowance >= amount) return undefined;
  return {
    to: usdc,
    data: approveCalldata(spender, amount),
    value: 0n,
  };
}

/** TokenMessengerV2 burn arguments; `hookData` picks depositForBurnWithHook. */
export interface BurnArgs {
  amount: bigint;
  destinationDomain: number;
  mintRecipient: Hex;
  burnToken: Address;
  destinationCaller: Hex;
  maxFee: bigint;
  minFinalityThreshold: number;
  hookData?: Hex;
}

/** Calldata for depositForBurn, or depositForBurnWithHook when there is hook data. */
export function burnCall(a: BurnArgs): Hex {
  const args = [
    { type: "uint", bits: 256, value: a.amount },
    { type: "uint", bits: 32, value: a.destinationDomain },
    { type: "bytes32", value: a.mintRecipient },
    { type: "address", value: a.burnToken },
    { type: "bytes32", value: a.destinationCaller },
    { type: "uint", bits: 256, value: a.maxFee },
    { type: "uint", bits: 32, value: a.minFinalityThreshold },
  ] as const;
  return a.hookData === undefined
    ? encodeCall("depositForBurn(uint256,uint32,bytes32,address,bytes32,uint256,uint32)", args)
    : encodeCall("depositForBurnWithHook(uint256,uint32,bytes32,address,bytes32,uint256,uint32,bytes)", [
        ...args,
        { type: "bytes", value: a.hookData },
      ]);
}

/** ERC20 approve(spender, amount) calldata. */
export function approveCalldata(spender: Address, amount: bigint): Hex {
  return encodeCall("approve(address,uint256)", [
    { type: "address", value: spender },
    { type: "uint", bits: 256, value: amount },
  ]);
}

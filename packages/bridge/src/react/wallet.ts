import { type Address, type Hex, type PublicClient, createWalletClient, custom, numberToHex } from "viem";
import type { EvmChain } from "../chains.js";
import { feeOverrides, toViemChain } from "../rpc.js";
import type { Eip1193Provider } from "./types.js";

/** Explorer home for a chain, from its transaction URL template. */
export function explorerBase(chain: EvmChain): string {
  return chain.explorerTx.replace(/\/tx\/\{hash\}$/, "");
}

/**
 * The wallet would not move to a chain, even after being asked to add it.
 * Wallets that live on one chain only (embedded Injective wallets) end up here
 * when a deposit asks for Base or Arbitrum; a cancel in the wallet does not.
 */
export class ChainSwitchError extends Error {
  readonly chainName: string;
  constructor(chain: EvmChain, cause: unknown) {
    super(`The wallet could not switch to ${chain.name}`, { cause });
    this.name = "ChainSwitchError";
    this.chainName = chain.name;
  }
}

const isRejection = (e: unknown) => {
  const err = e as { code?: number; message?: string; cause?: { code?: number } };
  return err.code === 4001 || err.cause?.code === 4001 || /user (rejected|denied)|rejected the request/i.test(err.message ?? "");
};

/** Puts the wallet on `chain`, adding it first when the wallet does not know it. */
export async function ensureChain(provider: Eip1193Provider, chain: EvmChain): Promise<void> {
  const current = Number(await provider.request({ method: "eth_chainId" }));
  if (current === chain.chainId) return;
  try {
    await switchTo(provider, chain);
  } catch (e) {
    if (isRejection(e)) throw e;
    throw new ChainSwitchError(chain, e);
  }
}

async function switchTo(provider: Eip1193Provider, chain: EvmChain): Promise<void> {
  const chainId = numberToHex(chain.chainId);
  try {
    await provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId }] });
  } catch (e) {
    // MetaMask says "unknown chain" with 4902; other wallets (Keplr, Rabby,
    // mobile wallets over WalletConnect) use other codes or words for the same
    // thing. So any failure other than a cancel, or a request the wallet still
    // has open (-32002: a second prompt would stack on it), gets one offer to
    // add the chain, and only a failed add means the wallet cannot go there.
    const err = e as { code?: number; cause?: { code?: number } };
    if (isRejection(e) || err.code === -32002 || err.cause?.code === -32002) throw e;
    await provider.request({
      method: "wallet_addEthereumChain",
      params: [
        {
          chainId,
          chainName: chain.name,
          nativeCurrency: { name: chain.nativeSymbol, symbol: chain.nativeSymbol, decimals: 18 },
          // Every endpoint, official first: wallets that keep a list fail over.
          rpcUrls: [...chain.rpcUrls],
          blockExplorerUrls: [explorerBase(chain)],
        },
      ],
    });
    // Some wallets add a chain without moving to it (and WalletConnect only
    // follows a switch), so ask once more.
    if (Number(await provider.request({ method: "eth_chainId" })) !== chain.chainId) {
      await provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId }] });
    }
  }
}

/**
 * Signs and sends one call from the user's wallet on `chain`, returning its
 * hash. On Injective it pins the fee and pads the gas: Injective bills the
 * whole gas limit at the max fee, MetaMask drops a zero tip, and estimates
 * run short there.
 */
export async function sendCall(
  provider: Eip1193Provider,
  from: Address,
  chain: EvmChain,
  client: PublicClient,
  call: { to: Address; data: Hex },
): Promise<Hex> {
  await ensureChain(provider, chain);
  const viemChain = toViemChain(chain);
  const wallet = createWalletClient({ account: from, chain: viemChain, transport: custom(provider) });
  let extra: { gas?: bigint; maxFeePerGas?: bigint; maxPriorityFeePerGas?: bigint } = {};
  if (chain.minPriorityFeeWei !== undefined) {
    const gas = await client.estimateGas({ account: from, to: call.to, data: call.data });
    extra = { gas: (gas * 13n) / 10n, ...((await feeOverrides(client, chain)) ?? {}) };
  }
  return wallet.sendTransaction({ account: from, chain: viemChain, to: call.to, data: call.data, value: 0n, ...extra });
}

/**
 * Whether the wallet runs several calls as one atomic batch on `chain` right
 * now (EIP-5792 `atomic: supported`: a smart account, or one already
 * upgraded). "ready" is left out on purpose: it means the wallet would first
 * ask to turn the account into a smart account, which is not this page's call
 * to prompt. Any error reads as no.
 */
export async function canBatch(provider: Eip1193Provider, from: Address, chain: EvmChain): Promise<boolean> {
  // Injective needs its fee and gas pinned per transaction, which a batch cannot carry.
  if (chain.minPriorityFeeWei !== undefined) return false;
  try {
    const wallet = createWalletClient({ account: from, transport: custom(provider) });
    const caps = (await wallet.getCapabilities({ account: from, chainId: chain.chainId })) as {
      atomic?: { status?: string };
      atomicBatch?: { supported?: boolean };
    };
    return caps?.atomic?.status === "supported" || caps?.atomicBatch?.supported === true;
  } catch {
    return false;
  }
}

/**
 * Sends `calls` as one atomic batch, one confirmation in the wallet, and
 * waits for it to land. Returns the hash of the transaction carrying the last
 * call (with a smart account, every call's).
 */
export async function sendBatch(
  provider: Eip1193Provider,
  from: Address,
  chain: EvmChain,
  calls: { to: Address; data: Hex }[],
  onSigned?: () => void,
): Promise<Hex> {
  await ensureChain(provider, chain);
  const viemChain = toViemChain(chain);
  const wallet = createWalletClient({ account: from, chain: viemChain, transport: custom(provider) });
  const { id } = await wallet.sendCalls({ account: from, chain: viemChain, calls: calls.map((c) => ({ ...c, value: 0n })), forceAtomic: true });
  onSigned?.();
  const result = await wallet.waitForCallsStatus({ id, timeout: 300_000 });
  const last = result.receipts?.at(-1);
  if (result.status !== "success" || !last) throw new Error("The wallet's batch did not go through");
  return last.transactionHash;
}

/** Plain words for a wallet or chain error. */
export function friendlyError(e: unknown): string {
  if (e instanceof ChainSwitchError) {
    return `Your wallet could not switch to ${e.chainName}, or add it. Wallets that only work on Injective can withdraw here; to bridge from ${e.chainName}, use a wallet that supports it, like MetaMask, Rabby or Keplr.`;
  }
  const err = e as { name?: string; code?: number; shortMessage?: string; message?: string; cause?: { code?: number } };
  const text = `${err.shortMessage ?? ""} ${err.message ?? ""}`;
  if (err.name === "UserRejectedRequestError" || err.code === 4001 || err.cause?.code === 4001 || /user (rejected|denied)|rejected the request/i.test(text)) {
    return "Cancelled in your wallet.";
  }
  if (/insufficient funds/i.test(text)) return "Not enough gas in your wallet for this network.";
  return (err.shortMessage ?? err.message ?? String(e)).split("\n")[0]!.slice(0, 200);
}

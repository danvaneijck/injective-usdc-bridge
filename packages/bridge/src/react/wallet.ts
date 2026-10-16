import { type Address, type Hex, type PublicClient, createWalletClient, custom, numberToHex } from "viem";
import type { EvmChain } from "../chains.js";
import { feeOverrides, toViemChain } from "../rpc.js";
import type { Eip1193Provider } from "./types.js";

/** Explorer home for a chain, from its transaction URL template. */
export function explorerBase(chain: EvmChain): string {
  return chain.explorerTx.replace(/\/tx\/\{hash\}$/, "");
}

/** Puts the wallet on `chain`, adding it first when the wallet does not know it. */
export async function ensureChain(provider: Eip1193Provider, chain: EvmChain): Promise<void> {
  const current = Number(await provider.request({ method: "eth_chainId" }));
  if (current === chain.chainId) return;
  const chainId = numberToHex(chain.chainId);
  try {
    await provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId }] });
  } catch (e) {
    const err = e as { code?: number; message?: string; data?: { originalError?: { code?: number } } };
    const unknown = err.code === 4902 || err.data?.originalError?.code === 4902 || /unrecognized|unknown chain|not added/i.test(err.message ?? "");
    if (!unknown) throw e;
    await provider.request({
      method: "wallet_addEthereumChain",
      params: [
        {
          chainId,
          chainName: chain.name,
          nativeCurrency: { name: chain.nativeSymbol, symbol: chain.nativeSymbol, decimals: 18 },
          rpcUrls: [chain.rpcUrls[0]],
          blockExplorerUrls: [explorerBase(chain)],
        },
      ],
    });
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

/** Plain words for a wallet or chain error. */
export function friendlyError(e: unknown): string {
  const err = e as { name?: string; code?: number; shortMessage?: string; message?: string; cause?: { code?: number } };
  const text = `${err.shortMessage ?? ""} ${err.message ?? ""}`;
  if (err.name === "UserRejectedRequestError" || err.code === 4001 || err.cause?.code === 4001 || /user (rejected|denied)|rejected the request/i.test(text)) {
    return "Cancelled in your wallet.";
  }
  if (/insufficient funds/i.test(text)) return "Not enough gas in your wallet for this network.";
  return (err.shortMessage ?? err.message ?? String(e)).split("\n")[0]!.slice(0, 200);
}

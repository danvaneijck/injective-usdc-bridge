import { useEffect, useMemo, useRef, useState } from "react";
import type { Address, PublicClient } from "viem";
import { erc20Abi } from "../abis.js";
import { type Chain, type EvmChain, injective, peers } from "../chains.js";
import { BRIDGE_RECEIVER, type Network, type Speed } from "../constants.js";
import { type GasDropConfig, readGasDropConfig } from "../gasDrop.js";
import { IrisClient } from "../iris.js";
import { type Quote, RouteError, quoteTransfer } from "../quote.js";
import { publicClientFor } from "../rpc.js";
import { type SolanaRecipientCheck, checkSolanaRecipient, isSolanaAddress, solanaBalance, solanaTokenBalance } from "../solana.js";
import { BridgeApi, type LaneHealth, type TransferView } from "./api.js";
import { Journal, type JournalEntry } from "./journal.js";
import { DEFAULT_API_URL } from "./types.js";

export interface Env {
  network: Network;
  api: BridgeApi;
  iris: IrisClient;
  journal: Journal;
  inj: EvmChain;
  /** Every chain that bridges with Injective: the EVM chains and Solana. */
  peerChains: Chain[];
  receiver: Address | undefined;
  clientFor(chain: EvmChain): PublicClient;
  chainById(chainId: number): EvmChain | undefined;
  /** Solana RPCs, the host's ahead of the registry's. */
  solanaRpc: string[];
}

export function useEnv(p: { network?: Network; apiUrl?: string; rpcUrls?: Partial<Record<string, string[]>> }): Env {
  const rpcKey = JSON.stringify(p.rpcUrls ?? {});
  return useMemo(() => {
    const network = p.network ?? "mainnet";
    const clients = new Map<string, PublicClient>();
    const inj = injective(network);
    const peerChains = [...peers(network)];
    const evm = [inj, ...peerChains.filter((c): c is EvmChain => c.kind === "evm")];
    const sol = peerChains.find((c) => c.kind === "solana");
    return {
      network,
      api: new BridgeApi(p.apiUrl ?? DEFAULT_API_URL),
      iris: new IrisClient({ network }),
      journal: new Journal(),
      inj,
      peerChains,
      receiver: BRIDGE_RECEIVER[network],
      clientFor(chain) {
        let c = clients.get(chain.key);
        if (!c) {
          c = publicClientFor(chain, [...(p.rpcUrls?.[chain.key] ?? []), ...chain.rpcUrls]);
          clients.set(chain.key, c);
        }
        return c;
      },
      chainById: (id) => evm.find((c) => c.chainId === id),
      solanaRpc: [...(p.rpcUrls?.solana ?? []), ...(sol?.rpcUrls ?? [])],
    };
    // rpcKey stands in for p.rpcUrls, whose identity changes every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.network, p.apiUrl, rpcKey]);
}

/** Re-renders every `ms`, for countdowns. */
export function useNow(ms = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

/** Runs `load` now and every `ms` while `key` is unchanged; null key = idle. */
export function usePoll<T>(key: string | null, load: () => Promise<T>, ms: number): { data: T | null; error: string | null; refresh: () => void } {
  const [state, setState] = useState<{ key: string | null; data: T | null; error: string | null }>({ key: null, data: null, error: null });
  const [tick, setTick] = useState(0);
  const loadRef = useRef(load);
  loadRef.current = load;
  useEffect(() => {
    if (key === null) {
      setState({ key: null, data: null, error: null });
      return;
    }
    let alive = true;
    const run = () =>
      loadRef.current().then(
        (data) => alive && setState({ key, data, error: null }),
        (e: unknown) => alive && setState((s) => ({ key, data: s.key === key ? s.data : null, error: String((e as Error).message ?? e) })),
      );
    void run();
    const t = setInterval(run, ms);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [key, ms, tick]);
  const current = state.key === key;
  return { data: current ? state.data : null, error: current ? state.error : null, refresh: () => setTick((n) => n + 1) };
}

/** USDC held by `owner` (0x on EVM chains, base58 on Solana). */
export function useUsdcBalance(env: Env, chain: Chain, owner: string | null): bigint | null {
  return usePoll(
    owner ? `usdc:${chain.key}:${owner}` : null,
    () =>
      chain.kind === "solana"
        ? solanaTokenBalance(env.solanaRpc, owner!, chain.usdcMint)
        : env.clientFor(chain).readContract({ address: chain.usdc, abi: erc20Abi, functionName: "balanceOf", args: [owner as Address] }),
    20_000,
  ).data;
}

export function useSolBalance(env: Env, owner: string | null): bigint | null {
  return usePoll(owner ? `sol:${owner}` : null, () => solanaBalance(env.solanaRpc, owner!), 30_000).data;
}

/**
 * Whether a Solana recipient is a wallet, and whether it already has a USDC
 * account (if not, Circle is asked to create one and the fee covers it).
 */
export function useSolanaRecipient(env: Env, chain: Chain, owner: string | null): SolanaRecipientCheck | null {
  const valid = chain.kind === "solana" && owner !== null && isSolanaAddress(owner);
  return usePoll(
    valid ? `solrcpt:${owner}` : null,
    () => checkSolanaRecipient(env.solanaRpc, owner!, (chain as { usdcMint: string }).usdcMint),
    60_000,
  ).data;
}

export function useInjBalance(env: Env, owner: Address | null): bigint | null {
  return usePoll(owner ? `inj:${owner}` : null, () => env.clientFor(env.inj).getBalance({ address: owner! }), 30_000).data;
}

export function useGasDrop(env: Env): GasDropConfig | null {
  return usePoll(env.receiver ? `drop:${env.receiver}` : null, () => readGasDropConfig(env.clientFor(env.inj), env.receiver!), 120_000).data;
}

export function useLanes(env: Env): LaneHealth[] {
  return usePoll("lanes", () => env.api.lanes(), 60_000).data ?? [];
}

export interface QuoteState {
  quote: Quote | null;
  error: string | null;
  loading: boolean;
}

/** Fees for the form as it stands, re-asked 350 ms after the last change. */
export function useQuote(
  env: Env,
  q: { source: Chain; destination: Chain; amount: bigint | null; speed: Speed; gasDropFee: bigint; recipientSetup?: boolean; ready?: boolean },
): QuoteState {
  // Each answer is kept with the inputs it was made for, so a quote for the
  // previous route, speed or amount is never shown (or signed) as this one's.
  const [state, setState] = useState<{ key: string | null; quote: Quote | null; error: string | null }>({ key: null, quote: null, error: null });
  const key =
    q.amount && q.amount > 0n && q.ready !== false
      ? `${q.source.key}>${q.destination.key}:${q.amount}:${q.speed}:${q.gasDropFee}:${q.recipientSetup ? "setup" : ""}`
      : null;
  useEffect(() => {
    if (!key) return;
    let alive = true;
    const t = setTimeout(() => {
      quoteTransfer({
        iris: env.iris,
        route: { source: q.source, destination: q.destination },
        amount: q.amount!,
        speed: q.speed,
        gasDropFee: q.gasDropFee,
        recipientSetup: q.recipientSetup === true,
      }).then(
        (quote) => alive && setState({ key, quote, error: null }),
        (e: unknown) =>
          alive &&
          setState({
            key,
            quote: null,
            error: e instanceof RouteError && /does not cover fees/.test(e.message) ? "Amount is too small to cover the fees" : "Could not get a quote, try again",
          }),
      );
    }, 350);
    return () => {
      alive = false;
      clearTimeout(t);
    };
    // key captures every input that matters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, env]);
  const current = key !== null && state.key === key;
  return { quote: current ? state.quote : null, error: current ? state.error : null, loading: key !== null && !current };
}

export interface ActivityItem {
  key: string;
  view: TransferView | null;
  /** Signed here and not known to the service yet. */
  pending: JournalEntry | null;
}

/**
 * The wallets' transfers (EVM and Solana): the service's lists, plus anything
 * this browser signed that the service has not returned yet (looked up one
 * by one, which also makes the service index it).
 */
export function useActivity(env: Env, addresses: string[]): { items: ActivityItem[]; loading: boolean; error: string | null } {
  const key = addresses.length ? `activity:${addresses.join(",")}` : null;
  const { data, error } = usePoll(
    key,
    async () => {
      // One wallet's lookup failing (say an older service that does not know
      // Solana addresses) must not hide the other's transfers.
      const settled = await Promise.allSettled(addresses.map((a) => env.api.transfers(a)));
      const lists = settled.flatMap((r) => (r.status === "fulfilled" ? [r.value] : []));
      if (lists.length === 0) throw (settled[0] as PromiseRejectedResult).reason;
      const byId = new Map(lists.flat().map((v) => [v.id, v]));
      const listed = [...byId.values()];
      const seen = new Set(listed.map((v) => `${v.source.domain}:${v.source.txHash.toLowerCase()}`));
      const missing = addresses
        .flatMap((a) => env.journal.forAddress(a))
        .filter((e, i, all) => all.findIndex((x) => x.domain === e.domain && x.txHash === e.txHash) === i)
        .filter((e) => !seen.has(`${e.domain}:${e.txHash.toLowerCase()}`));
      const found = await Promise.all(missing.map((e) => env.api.transfer(e.domain, e.txHash).catch(() => [] as TransferView[])));
      const items: ActivityItem[] = listed.map((v) => ({ key: v.id, view: v, pending: null }));
      missing.forEach((e, i) => {
        const views = found[i] ?? [];
        if (views.length) for (const v of views) items.push({ key: v.id, view: v, pending: null });
        else items.push({ key: `${e.domain}:${e.txHash}`, view: null, pending: e });
      });
      const when = (it: ActivityItem) => (it.view?.source.time ? Date.parse(it.view.source.time) : (it.pending?.at ?? 0));
      return items.sort((a, b) => when(b) - when(a));
    },
    15_000,
  );
  return { items: data ?? [], loading: key !== null && data === null && error === null, error };
}

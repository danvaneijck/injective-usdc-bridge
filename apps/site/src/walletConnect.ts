import { injective, peers, type EvmChain } from "injective-usdc-bridge";
import type { Eip1193Provider } from "injective-usdc-bridge/react";
import { numberToHex } from "viem";
import type UniversalProvider from "@walletconnect/universal-provider";

/**
 * WalletConnect, for phone wallets and anything without a browser extension.
 * The project id is public (it ships in every page that uses it); without one
 * the option is not offered. The library loads only when someone picks it.
 */
export const WC_PROJECT_ID: string = import.meta.env.VITE_WALLETCONNECT_PROJECT_ID ?? "";

const EVM_CHAINS = [injective("mainnet"), ...peers("mainnet")].filter((c): c is EvmChain => c.kind === "evm");

const METHODS = [
  "eth_sendTransaction",
  "personal_sign",
  "eth_signTypedData_v4",
  "wallet_switchEthereumChain",
  "wallet_addEthereumChain",
  "wallet_getCapabilities",
  "wallet_sendCalls",
  "wallet_getCallsStatus",
];

export interface WcSession {
  provider: Eip1193Provider;
  address: string;
  /** The wallet on the other end, as it names itself. */
  name: string;
  icon: string;
  disconnect(): Promise<void>;
  /** Called once when the wallet ends the session. */
  onEnd(listener: () => void): () => void;
}

let instance: Promise<UniversalProvider> | null = null;
/** Ends the pairing wait in progress, if any. */
let cancelPending: (() => void) | null = null;

function load(): Promise<UniversalProvider> {
  instance ??= import("@walletconnect/universal-provider").then(({ UniversalProvider: Provider }) =>
    Provider.init({
      projectId: WC_PROJECT_ID,
      logger: "error",
      metadata: {
        name: "Choice Bridge",
        description: "Bridge USDC to and from Injective",
        url: window.location.origin,
        icons: [`${window.location.origin}/choice-logo.svg`],
      },
    }),
  );
  return instance;
}

/** The provider speaks EIP-1193 but for eth_chainId, which it answers with a number. */
function adapt(up: UniversalProvider): Eip1193Provider {
  return {
    async request({ method, params }) {
      const result = await up.request({ method, params: params as unknown[] | undefined });
      return method === "eth_chainId" ? numberToHex(Number(result)) : result;
    },
    on: (event, listener) => up.on(event, listener),
    removeListener: (event, listener) => up.removeListener(event, listener),
  };
}

function sessionOf(up: UniversalProvider): WcSession | null {
  const s = up.session;
  // Accounts read "eip155:<chain>:<address>".
  const address = s?.namespaces.eip155?.accounts[0]?.split(":")[2];
  if (!s || !address) return null;
  return {
    provider: adapt(up),
    address,
    name: s.peer.metadata.name || "WalletConnect",
    icon: s.peer.metadata.icons[0] ?? "",
    disconnect: () => up.disconnect(),
    onEnd(listener) {
      up.on("session_delete", listener);
      up.on("disconnect", listener);
      return () => {
        up.removeListener("session_delete", listener);
        up.removeListener("disconnect", listener);
      };
    },
  };
}

/** The session this browser kept from last time, if the wallet still holds it. */
export async function restoreWalletConnect(): Promise<WcSession | null> {
  return sessionOf(await load());
}

/** How long WalletConnect's relay gets to hand out a pairing link before we say so. */
const RELAY_TIMEOUT_MS = 15_000;
const NO_RELAY = "WalletConnect did not answer. Try again in a moment.";

/** Pairs a wallet: `onUri` gets the link to show as a QR code or open in a phone wallet. */
export async function connectWalletConnect(onUri: (uri: string) => void): Promise<WcSession> {
  // An unreachable relay never settles; give up on it, and start afresh next time.
  let timer: ReturnType<typeof setTimeout> | undefined;
  const up = await Promise.race([
    load(),
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(NO_RELAY)), RELAY_TIMEOUT_MS);
    }),
  ]).catch((e: unknown) => {
    instance = null;
    throw e;
  });
  clearTimeout(timer);
  let shown = false;
  const show = (uri: string) => {
    shown = true;
    onUri(uri);
  };
  let late: ReturnType<typeof setTimeout> | undefined;
  // connect() can wait forever (a relay that refuses us, a pairing the user
  // walked away from), abort or not: these settle the wait instead.
  const stopped = new Promise<never>((_, reject) => {
    late = setTimeout(() => {
      if (shown) return;
      up.abortPairingAttempt();
      reject(new Error(NO_RELAY));
    }, RELAY_TIMEOUT_MS);
    cancelPending = () => {
      up.abortPairingAttempt();
      reject(new Error("cancelled"));
    };
  });
  up.on("display_uri", show);
  try {
    const pairing = up.connect({
      optionalNamespaces: {
        eip155: {
          chains: EVM_CHAINS.map((c) => `eip155:${c.chainId}`),
          methods: METHODS,
          events: ["chainChanged", "accountsChanged"],
          rpcMap: Object.fromEntries(EVM_CHAINS.map((c) => [String(c.chainId), c.rpcUrls[0]!])),
        },
      },
    });
    pairing.catch(() => undefined);
    await Promise.race([pairing, stopped]);
  } catch (e) {
    throw shown ? e : e instanceof Error && e.message === "cancelled" ? e : new Error(NO_RELAY);
  } finally {
    clearTimeout(late);
    cancelPending = null;
    up.removeListener("display_uri", show);
  }
  const session = sessionOf(up);
  if (!session) throw new Error("The wallet shared no Ethereum account");
  return session;
}

/** Stops waiting for a pairing the user walked away from. */
export function abortWalletConnect(): void {
  cancelPending?.();
}

/** Phone wallets that open a WalletConnect link directly. Others scan the QR code or take the copied link. */
export const WC_WALLETS: { name: string; link: (uri: string) => string }[] = [
  { name: "MetaMask", link: (uri) => `https://metamask.app.link/wc?uri=${encodeURIComponent(uri)}` },
  { name: "Trust Wallet", link: (uri) => `https://link.trustwallet.com/wc?uri=${encodeURIComponent(uri)}` },
  { name: "Rainbow", link: (uri) => `https://rnbwapp.com/wc?uri=${encodeURIComponent(uri)}` },
];

import { base58 } from "@scure/base";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { type Address, type Hex, formatEther, formatUnits, getAddress, isAddress, parseEther } from "viem";
import { erc20Abi } from "../abis.js";
import { toEvmAddress, toInjAddress } from "../address.js";
import { buildBurn } from "../burn.js";
import type { Chain } from "../chains.js";
import { CCTP_CONTRACTS, FINALITY, type Speed, USDC_DECIMALS } from "../constants.js";
import type { Direction } from "../quote.js";
import { isSolanaAddress } from "../solana.js";
import { buildSolanaBurn, confirmSolanaSignature, submitSolanaTransaction, transactionSignature } from "../solanaBurn.js";
import { expectedAttestMs } from "../timing.js";
import { ChainLogo, UsdcLogo } from "./ChainLogo.js";
import { ChainPicker } from "./ChainPicker.js";
import { formatAmount, formatDuration, formatUsdc, parseUsdc, sanitizeAmountInput, shortAddress } from "./format.js";
import { type Env, useGasDrop, useInjBalance, useLanes, useQuote, useSolBalance, useSolanaRecipient, useUsdcBalance } from "./hooks.js";
import { IconAlert, IconBolt, IconChevron, IconClock, IconFlip, IconInfo, IconWallet, Spinner } from "./icons.js";
import type { Eip1193Provider, SolanaWallet } from "./types.js";
import { friendlyError, sendCall } from "./wallet.js";

/** Under this much INJ, the gas drop starts ticked. */
const LOW_INJ = parseEther("0.01");
/**
 * SOL a burn on Solana needs: fees plus rent for the account that carries the
 * message. Measured by mainnet simulation 2026-10-17: 0.00289 SOL plain,
 * 0.00338 with the gas-drop hook. The exact figure comes from the simulation
 * at signing; this only gates the button and labels the fee.
 */
const SOL_FOR_BURN = (withHook: boolean) => (withHook ? 3_450_000n : 2_950_000n);

type Busy = null | "approving" | "sending" | "preparing" | "confirming";

const BUSY_LABEL: Record<Exclude<Busy, null>, string> = {
  approving: "Approving USDC",
  sending: "Confirm in your wallet",
  preparing: "Preparing the transaction",
  confirming: "Waiting for Solana",
};

const RECIPIENT_PROBLEM = {
  not_an_address: "That is not a Solana address.",
  token_account: "That is a token account, not a wallet. Paste the wallet address it belongs to.",
  not_a_wallet: "That address is a program account, not a wallet. Paste a wallet address.",
} as const;

export interface BridgeFormProps {
  env: Env;
  address: Address | null;
  provider: Eip1193Provider | null;
  onConnectWallet?: (() => void) | undefined;
  solanaWallet: SolanaWallet | null;
  onConnectSolanaWallet?: (() => void) | undefined;
  onSent(domain: number, txHash: string): void;
  defaultChain?: string | undefined;
  defaultDirection?: Direction | undefined;
}

export function BridgeForm({
  env,
  address,
  provider,
  onConnectWallet,
  solanaWallet,
  onConnectSolanaWallet,
  onSent,
  defaultChain,
  defaultDirection,
}: BridgeFormProps) {
  const [direction, setDirection] = useState<Direction>(defaultDirection ?? "deposit");
  const [peerKey, setPeerKey] = useState(defaultChain ?? "base");
  const [amountText, setAmountText] = useState("");
  const [speedChoice, setSpeedChoice] = useState<Speed | null>(null);
  const [dropChoice, setDropChoice] = useState<boolean | null>(null);
  const [recipientText, setRecipientText] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);
  const [busy, setBusy] = useState<Busy>(null);
  const [error, setError] = useState<string | null>(null);
  const [flips, setFlips] = useState(0);
  const [details, setDetails] = useState(false);
  const body = useRef<HTMLDivElement>(null);

  // While the chain sheet is up, the form behind it is out of reach of
  // keyboards and screen readers. (React 18 has no `inert` prop.)
  useEffect(() => {
    body.current?.toggleAttribute("inert", picking);
  }, [picking]);

  const peer = env.peerChains.find((c) => c.key === peerKey) ?? env.peerChains[0]!;
  const deposit = direction === "deposit";
  const source: Chain = deposit ? peer : env.inj;
  const destination: Chain = deposit ? env.inj : peer;
  const fromSolana = source.kind === "solana";
  const toSolana = destination.kind === "solana";
  const solAddress = solanaWallet?.address ?? null;
  /** Who signs the burn: the Solana wallet for burns on Solana, else the EVM wallet. */
  const sender = fromSolana ? solAddress : address;
  const amount = parseUsdc(amountText);
  const speed: Speed = source.fastSource ? (speedChoice ?? "fast") : "standard";

  const defaultRecipient = toSolana ? solAddress : address;
  const recipient: string | null =
    recipientText === null
      ? defaultRecipient
      : deposit
        ? toEvmAddress(recipientText)
        : toSolana
          ? isSolanaAddress(recipientText) ? recipientText.trim() : null
          : isAddress(recipientText.trim(), { strict: false })
            ? getAddress(recipientText.trim())
            : null;

  const balance = useUsdcBalance(env, source, sender);
  const solBalance = useSolBalance(env, fromSolana ? solAddress : null);
  const injBalance = useInjBalance(env, deposit ? (recipient as Address | null) : null);
  const solRecipient = useSolanaRecipient(env, destination, toSolana ? recipient : null);
  const recipientSetup = toSolana && solRecipient?.ok === true && !solRecipient.tokenAccountExists;
  const recipientProblem = toSolana && recipient && solRecipient && !solRecipient.ok ? RECIPIENT_PROBLEM[solRecipient.reason] : null;
  const drop = useGasDrop(env);
  const dropOffered = deposit && drop?.available === true && env.receiver !== undefined;
  const wantDrop = dropOffered && (dropChoice ?? (injBalance !== null && injBalance < LOW_INJ));
  const { quote, error: quoteError, loading } = useQuote(env, {
    source,
    destination,
    amount,
    speed,
    gasDropFee: wantDrop && drop ? drop.dropFee : 0n,
    recipientSetup,
    // A Solana recipient's account check decides the fee; wait for it.
    ready: !toSolana || recipient === null || solRecipient !== null,
  });
  const lanes = useLanes(env);
  const slowLane = lanes.find((l) => l.domain === source.domain && l.status === "delayed");

  const fresh = quote !== null && amount !== null && quote.amount === amount;
  const fastEta = expectedAttestMs(env.network, source.domain, FINALITY.fast);
  const standardEta = expectedAttestMs(env.network, source.domain, FINALITY.standard);
  const eta = speed === "fast" ? fastEta : standardEta;
  const solNeeded = SOL_FOR_BURN(wantDrop);

  function flip() {
    setDirection(deposit ? "withdraw" : "deposit");
    setRecipientText(null);
    setSpeedChoice(null);
    setError(null);
    setFlips((n) => n + 1);
  }

  /** Remember the burn the moment it has an id, so a closed tab never loses it. */
  function record(domain: number, txHash: string, by: string) {
    env.journal.add({ domain, txHash, address: by.toLowerCase(), at: Date.now() });
    void env.api.hint(domain, txHash);
  }

  async function submitSolana() {
    if (!solanaWallet || !quote || !recipient) return;
    setBusy("preparing");
    const plan = await buildSolanaBurn({
      route: { source, destination },
      quote,
      owner: solanaWallet.address,
      recipient,
      rpcUrls: env.solanaRpc,
      ...(wantDrop && drop && env.receiver ? { gasDrop: { receiver: env.receiver, maxDropFee: drop.dropFee } } : {}),
    });
    setBusy("sending");
    let signature: string;
    if (solanaWallet.signAndSendTransaction) {
      const sig = await solanaWallet.signAndSendTransaction(plan.transaction);
      signature = typeof sig === "string" ? sig : base58.encode(sig);
      record(source.domain, signature, solanaWallet.address);
      setBusy("confirming");
      await confirmSolanaSignature(env.solanaRpc, signature, plan.lastValidBlockHeight);
    } else if (solanaWallet.signTransaction) {
      const signed = await solanaWallet.signTransaction(plan.transaction);
      signature = transactionSignature(signed);
      record(source.domain, signature, solanaWallet.address);
      setBusy("confirming");
      await submitSolanaTransaction(env.solanaRpc, signed, plan.lastValidBlockHeight);
    } else {
      throw new Error("This Solana wallet cannot sign transactions.");
    }
    setAmountText("");
    onSent(source.domain, signature);
  }

  async function submitEvm() {
    if (!provider || !address || !quote || !recipient || source.kind !== "evm") return;
    const client = env.clientFor(source);
    const spender = CCTP_CONTRACTS[env.network].tokenMessenger;
    const allowance = await client.readContract({ address: source.usdc, abi: erc20Abi, functionName: "allowance", args: [address, spender] });
    const plan = buildBurn({
      network: env.network,
      route: { source, destination },
      quote,
      recipient,
      allowance,
      ...(wantDrop && drop && env.receiver ? { gasDrop: { receiver: env.receiver, maxDropFee: drop.dropFee } } : {}),
    });
    if (plan.approve) {
      setBusy("approving");
      const approval = await sendCall(provider, address, source, client, plan.approve);
      await client.waitForTransactionReceipt({ hash: approval, timeout: 180_000 });
    }
    setBusy("sending");
    const hash: Hex = await sendCall(provider, address, source, client, plan.burn);
    record(source.domain, hash, address);
    setAmountText("");
    onSent(source.domain, hash);
  }

  async function submit() {
    if (!quote || !recipient || !fresh) return;
    setError(null);
    try {
      await (fromSolana ? submitSolana() : submitEvm());
    } catch (e) {
      setError(friendlyError(e));
    } finally {
      setBusy(null);
    }
  }

  let action: { label: string; enabled: boolean; run?: () => void };
  if (fromSolana && !solAddress) {
    action = { label: "Connect a Solana wallet", enabled: Boolean(onConnectSolanaWallet), ...(onConnectSolanaWallet ? { run: onConnectSolanaWallet } : {}) };
  } else if (!fromSolana && !address) {
    action = { label: "Connect wallet", enabled: Boolean(onConnectWallet), ...(onConnectWallet ? { run: onConnectWallet } : {}) };
  } else if (busy) action = { label: BUSY_LABEL[busy], enabled: false };
  else if (amount === null || amount === 0n) action = { label: "Enter an amount", enabled: false };
  else if (!recipient) {
    action = { label: deposit ? "Enter your Injective address" : toSolana ? "Enter a Solana wallet address" : "Enter a valid recipient", enabled: false };
  } else if (recipientProblem) action = { label: "Check the recipient", enabled: false };
  else if (toSolana && solRecipient === null) action = { label: "Checking the recipient", enabled: false };
  else if (balance !== null && amount > balance) action = { label: `Not enough USDC on ${source.name}`, enabled: false };
  else if (fromSolana && solBalance !== null && solBalance < solNeeded) action = { label: "Not enough SOL for the network fee", enabled: false };
  else if (quoteError) action = { label: quoteError, enabled: false };
  else if (!fresh) action = { label: "Getting a quote", enabled: false };
  else action = { label: deposit ? "Bridge to Injective" : `Bridge to ${destination.name}`, enabled: true, run: () => void submit() };

  // After a flip each panel slides in from where the other one was.
  const swap = flips > 0;
  const fee = quote && fresh ? quote.protocolFee + quote.forwardingFee + quote.bridgeFee : null;

  return (
    <>
      <div className="iub-body" ref={body}>
        <Side
          key={`from:${direction}`}
          className={swap ? "iub-swap-up" : undefined}
          label="From"
          chain={source}
          locked={!deposit}
          onPick={() => setPicking(true)}
          extra={
            sender && balance !== null ? (
              <span className="iub-balance">
                <span className="iub-muted">Balance</span> {formatUsdc(balance)}
                {balance > 0n ? (
                  <button type="button" className="iub-max" onClick={() => setAmountText(formatUnits(balance, USDC_DECIMALS))}>
                    MAX
                  </button>
                ) : null}
              </span>
            ) : null
          }
        >
          <div className="iub-amount">
            <input
              className="iub-amount-input"
              inputMode="decimal"
              autoComplete="off"
              placeholder="0.00"
              aria-label="Amount of USDC"
              value={amountText}
              onChange={(e) => setAmountText(sanitizeAmountInput(e.target.value))}
            />
            <span className="iub-token">
              <UsdcLogo size={22} /> USDC
            </span>
          </div>
        </Side>

        <div className="iub-flip-row">
          <button type="button" className="iub-flip" onClick={flip} aria-label="Swap direction" style={{ transform: `rotate(${flips * 180}deg)` }}>
            <IconFlip />
          </button>
        </div>

        <Side
          key={`to:${direction}`}
          className={swap ? "iub-swap-down" : undefined}
          label="To"
          chain={destination}
          locked={deposit}
          onPick={() => setPicking(true)}
        >
          <div className="iub-amount iub-amount-out">
            {loading && !fresh ? (
              <span className="iub-skeleton iub-skeleton-amount" aria-label="Getting a quote" />
            ) : (
              <span key={fresh ? String(quote.minReceived) : "none"} className={fresh ? "iub-amount-value iub-fade" : "iub-amount-value iub-dim"}>
                {fresh ? formatUsdc(quote.minReceived, 6) : "0.00"}
              </span>
            )}
            <span className="iub-token">
              <UsdcLogo size={22} /> USDC
            </span>
          </div>
          {wantDrop && drop ? <div className="iub-plus">+ {formatEther(drop.dropWei)} INJ for gas</div> : null}
        </Side>

        {slowLane ? (
          <Note tone="warn">
            Circle is slower than usual to approve transfers from {source.name} right now. Transfers are safe and still complete.
          </Note>
        ) : null}

        {source.fastSource ? (
          <div className="iub-segment" role="radiogroup" aria-label="Speed" data-active={speed === "fast" ? "0" : "1"}>
            <span className="iub-segment-indicator" aria-hidden />
            <button type="button" role="radio" aria-checked={speed === "fast"} onClick={() => setSpeedChoice("fast")}>
              <span className="iub-segment-title">
                <IconBolt /> Fast
              </span>
              <span className="iub-segment-sub">About {formatDuration(fastEta)}</span>
            </button>
            <button type="button" role="radio" aria-checked={speed === "standard"} onClick={() => setSpeedChoice("standard")}>
              <span className="iub-segment-title">
                <IconClock /> Standard
              </span>
              <span className="iub-segment-sub">About {formatDuration(standardEta)}, no Circle fee</span>
            </button>
          </div>
        ) : null}

        {dropOffered && drop ? (
          <button type="button" role="switch" aria-checked={wantDrop} className="iub-toggle-row" onClick={() => setDropChoice(!wantDrop)}>
            <ChainLogo chain="injective" name="Injective" size={32} />
            <span className="iub-toggle-text">
              <strong>Add {formatEther(drop.dropWei)} INJ for gas</strong>
              <span className="iub-muted">
                {formatUsdc(drop.dropFee)} USDC.{" "}
                {injBalance === 0n ? "Your Injective wallet has no INJ yet." : "Pays for your first transactions on Injective."}
              </span>
            </span>
            <span className="iub-switch" aria-hidden />
          </button>
        ) : null}

        <Recipient
          deposit={deposit}
          destination={destination}
          fallback={defaultRecipient}
          text={recipientText}
          valid={recipient !== null && recipientProblem === null}
          onChange={setRecipientText}
          connect={
            deposit && !address && onConnectWallet
              ? { label: "Connect wallet", run: onConnectWallet }
              : toSolana && !solAddress && onConnectSolanaWallet
                ? { label: "Connect Solana wallet", run: onConnectSolanaWallet }
                : null
          }
        />
        {recipientProblem ? <Note tone="error">{recipientProblem}</Note> : null}

        {!deposit && !destination.forwarding ? (
          <Note>
            Circle does not deliver on {destination.name}. Once approved, you claim it there yourself, which needs {destination.nativeSymbol} for gas.
          </Note>
        ) : null}

        {quote && fresh && fee !== null ? (
          <div className={details ? "iub-details iub-open" : "iub-details"}>
            <button type="button" className="iub-details-toggle" aria-expanded={details} onClick={() => setDetails((d) => !d)}>
              <span className="iub-details-time">
                <IconClock /> About {formatDuration(eta)}
              </span>
              <span className="iub-details-fee">
                {fee === 0n ? "No fees" : `${quote.protocolFee > 0n ? "Fees up to" : "Fees"} ${formatUsdc(fee, 6)} USDC`}
              </span>
              <span className="iub-details-chevron">
                <IconChevron />
              </span>
            </button>
            <div className="iub-details-body">
              <div>
                <dl className="iub-fees">
                  <div>
                    <dt>Circle fee</dt>
                    <dd>{quote.protocolFee > 0n ? `Up to ${formatUsdc(quote.protocolFee, 6)} USDC` : "Free"}</dd>
                  </div>
                  <div>
                    <dt>Delivery</dt>
                    <dd>
                      {quote.forwarded
                        ? `${formatUsdc(quote.forwardingFee, 6)} USDC, by Circle`
                        : deposit
                          ? "Free, done for you"
                          : "You claim it"}
                    </dd>
                  </div>
                  {quote.recipientSetup ? (
                    <div>
                      <dt>USDC account</dt>
                      <dd>Opened for the recipient, in the delivery fee</dd>
                    </div>
                  ) : null}
                  {quote.gasDropFee > 0n && drop ? (
                    <div>
                      <dt>{formatEther(drop.dropWei)} INJ for gas</dt>
                      <dd>{formatUsdc(quote.gasDropFee)} USDC</dd>
                    </div>
                  ) : null}
                  {fromSolana ? (
                    <div>
                      <dt>Solana network fee</dt>
                      <dd>About {formatAmount(solNeeded, 9, 4)} SOL</dd>
                    </div>
                  ) : null}
                  <div className="iub-fees-total">
                    <dt>You receive at least</dt>
                    <dd>
                      {formatUsdc(quote.minReceived, 6)} USDC{quote.gasDropFee > 0n && drop ? ` + ${formatEther(drop.dropWei)} INJ` : ""}
                    </dd>
                  </div>
                  <div>
                    <dt>Time</dt>
                    <dd>About {formatDuration(eta)}</dd>
                  </div>
                </dl>
              </div>
            </div>
          </div>
        ) : null}

        {error ? <Note tone="error">{error}</Note> : null}

        <button type="button" className={busy ? "iub-primary iub-primary-busy" : "iub-primary"} disabled={!action.enabled} onClick={action.run}>
          {busy || (loading && !fresh && amount) ? <Spinner /> : null}
          {action.label}
        </button>
      </div>

      <ChainPicker
        open={picking}
        network={env.network}
        chains={env.peerChains}
        direction={direction}
        selected={peer.key}
        onPick={(key) => {
          setPeerKey(key);
          setSpeedChoice(null);
          setRecipientText(null);
          setPicking(false);
        }}
        onClose={() => setPicking(false)}
      />
    </>
  );
}

function Note({ tone, children }: { tone?: "warn" | "error"; children: ReactNode }) {
  return (
    <div className={tone ? `iub-note iub-note-${tone}` : "iub-note"} role={tone === "error" ? "alert" : undefined}>
      {tone ? <IconAlert /> : <IconInfo />}
      <span>{children}</span>
    </div>
  );
}

function Side({
  label,
  chain,
  locked,
  onPick,
  extra,
  className,
  children,
}: {
  label: string;
  chain: Chain;
  locked: boolean;
  onPick: () => void;
  extra?: ReactNode;
  className?: string | undefined;
  children: ReactNode;
}) {
  return (
    <div className={className ? `iub-side ${className}` : "iub-side"}>
      <div className="iub-side-head">
        <span className="iub-label">{label}</span>
        {extra}
      </div>
      {locked ? (
        <div className="iub-chain iub-chain-locked">
          <ChainLogo chain={chain.key} name={chain.name} size={26} />
          <span>{chain.name}</span>
        </div>
      ) : (
        <button type="button" className="iub-chain" onClick={onPick} aria-haspopup="dialog">
          <ChainLogo chain={chain.key} name={chain.name} size={26} />
          <span>{chain.name}</span>
          <IconChevron />
        </button>
      )}
      {children}
    </div>
  );
}

function Recipient({
  deposit,
  destination,
  fallback,
  text,
  valid,
  onChange,
  connect,
}: {
  deposit: boolean;
  destination: Chain;
  /** The connected wallet that receives by default, if any. */
  fallback: string | null;
  text: string | null;
  valid: boolean;
  onChange: (t: string | null) => void;
  connect: { label: string; run: () => void } | null;
}) {
  if (text === null && fallback) {
    const shown = deposit ? toInjAddress(fallback as Address) : fallback;
    return (
      <div className="iub-recipient">
        <IconWallet />
        <span className="iub-muted">To your wallet on {destination.name}</span>
        <span className="iub-mono" title={shown}>
          {shortAddress(shown)}
        </span>
        <button type="button" className="iub-link" onClick={() => onChange("")}>
          Change
        </button>
      </div>
    );
  }
  const value = text ?? "";
  return (
    <div className="iub-recipient-edit">
      <input
        className={valid || value === "" ? "iub-input" : "iub-input iub-input-bad"}
        placeholder={
          deposit
            ? "Your Injective address, inj1... or 0x..."
            : destination.kind === "solana"
              ? "Solana wallet address"
              : `0x... address on ${destination.name}`
        }
        aria-label={`Recipient on ${destination.name}`}
        value={value}
        spellCheck={false}
        autoComplete="off"
        onChange={(e) => onChange(e.target.value)}
      />
      {fallback ? (
        <button type="button" className="iub-link" onClick={() => onChange(null)}>
          Use my wallet
        </button>
      ) : connect ? (
        <button type="button" className="iub-link" onClick={connect.run}>
          {connect.label}
        </button>
      ) : null}
    </div>
  );
}

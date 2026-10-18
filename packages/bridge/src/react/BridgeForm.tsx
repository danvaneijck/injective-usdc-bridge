import { type ReactNode, useEffect, useRef, useState } from "react";
import { type Address, type Hex, formatEther, formatUnits, getAddress, isAddress, parseEther } from "viem";
import { erc20Abi } from "../abis.js";
import { toEvmAddress, toInjAddress } from "../address.js";
import { buildBurn } from "../burn.js";
import type { Chain } from "../chains.js";
import { CCTP_CONTRACTS, FINALITY, type Speed, USDC_DECIMALS } from "../constants.js";
import type { Direction } from "../quote.js";
import { isSolanaAddress } from "../solana.js";
import { buildSolanaBurn } from "../solanaBurn.js";
import { expectedAttestMs } from "../timing.js";
import { ChainLogo, UsdcLogo } from "./ChainLogo.js";
import { ChainPicker } from "./ChainPicker.js";
import { formatAmount, formatDuration, formatUsdc, parseUsdc, sanitizeAmountInput, shortAddress } from "./format.js";
import { CLAIM_GAS_UNITS, formatGasAmount, gasShort } from "./gas.js";
import {
  type Env,
  richestChain,
  useGas,
  useGasCost,
  useGasDrop,
  useInjBalance,
  useLanes,
  useQuote,
  useSolBalance,
  useSolanaRecipient,
  useUsdcBalance,
  useUsdcBalances,
} from "./hooks.js";
import { IconAlert, IconBolt, IconChevron, IconClock, IconFlip, IconInfo, IconParcel, IconWallet, Spinner } from "./icons.js";
import { sendWithSolanaWallet } from "./solanaSend.js";
import type { Eip1193Provider, SolanaWallet } from "./types.js";
import { canBatch, friendlyError, sendBatch, sendCall } from "./wallet.js";

/** Under this much INJ, the gas drop starts ticked. */
const LOW_INJ = parseEther("0.01");
/**
 * SOL a burn on Solana needs: fees plus rent for the account that carries the
 * message. Measured by mainnet simulation 2026-10-17: 0.00289 SOL plain,
 * 0.00338 with the gas-drop hook. The exact figure comes from the simulation
 * at signing; this only gates the button and labels the fee.
 */
const SOL_FOR_BURN = (withHook: boolean) => (withHook ? 3_450_000n : 2_950_000n);
/** SOL a claim on Solana takes: fees and the nonce account's rent (0.00071 measured 2026-10-17), plus 0.002 to open a USDC account. */
const SOL_FOR_CLAIM = 1_000_000n;
const SOL_FOR_CLAIM_OPENING = 3_200_000n;

type Busy = null | "approving" | "sending" | "preparing" | "confirming";

const BUSY_LABEL: Record<Exclude<Busy, null>, (chain: string) => string> = {
  approving: () => "Approving USDC",
  sending: () => "Confirm in your wallet",
  preparing: () => "Preparing the transaction",
  confirming: (chain) => `Waiting for ${chain}`,
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
  /** Withdrawals: claim on the destination instead of paying Circle to deliver. */
  const [claimChoice, setClaimChoice] = useState(false);
  const [recipientText, setRecipientText] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);
  const [busy, setBusy] = useState<Busy>(null);
  const [error, setError] = useState<string | null>(null);
  const [flips, setFlips] = useState(0);
  const [details, setDetails] = useState(false);
  /** A send pressed mid re-check: the amount it showed, to hold the fresh quote to. */
  const [queued, setQueued] = useState<bigint | null>(null);
  /** The user (or the host, through defaultChain) chose the chain: never move it for them. */
  const [chainChosen, setChainChosen] = useState(defaultChain !== undefined);
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
  const balances = useUsdcBalances(env, address, solAddress);

  // Start a deposit where the wallet's USDC is, once per wallet, unless a
  // chain was chosen or the current one already holds some.
  const preselectedFor = useRef<string | null>(null);
  useEffect(() => {
    const who = `${address ?? ""}|${solAddress ?? ""}`;
    if (chainChosen || !deposit || !balances.settled || preselectedFor.current === who) return;
    preselectedFor.current = who;
    const best = richestChain(balances.byChain, peer.key);
    if (best) {
      setPeerKey(best);
      setSpeedChoice(null);
      setRecipientText(null);
    }
  }, [address, solAddress, balances, chainChosen, deposit, peer.key]);
  const gas = useGas(env, source, fromSolana ? null : address);
  const gasNote = gasShort(gas, source.nativeSymbol, source.name);
  const injBalance = useInjBalance(env, deposit ? (recipient as Address | null) : null);
  const solRecipient = useSolanaRecipient(env, destination, toSolana ? recipient : null);
  const needsAccount = toSolana && solRecipient?.ok === true && !solRecipient.tokenAccountExists;
  const recipientProblem = toSolana && recipient && solRecipient && !solRecipient.ok ? RECIPIENT_PROBLEM[solRecipient.reason] : null;

  // Delivery. Where Circle delivers, the user may claim instead and skip its
  // fee; elsewhere claiming is the only way. A claim on Solana opens a missing
  // USDC account, which takes its owner: only the connected wallet is sure.
  const forwardable = !deposit && destination.forwarding;
  const selfClaimable = !toSolana || (solRecipient?.ok === true && (solRecipient.tokenAccountExists || recipient === solAddress));
  const selfClaim = !deposit && (!destination.forwarding || (claimChoice && selfClaimable));
  const recipientSetup = needsAccount && !selfClaim;
  const claimSol = needsAccount ? SOL_FOR_CLAIM_OPENING : SOL_FOR_CLAIM;

  const solBalance = useSolBalance(env, fromSolana || (toSolana && selfClaim) ? solAddress : null);
  const claimGas = useGas(env, destination, selfClaim && destination.kind === "evm" ? address : null, CLAIM_GAS_UNITS);
  // Priced up front, so both delivery options show what they cost.
  const claimCost = useGasCost(env, destination, CLAIM_GAS_UNITS, forwardable && !toSolana);
  const claimGasNote = !selfClaim
    ? null
    : toSolana
      ? solAddress
        ? gasShort(solBalance === null ? null : { balance: solBalance, need: claimSol }, "SOL", "Solana", "Claiming", 9)
        : null
      : gasShort(claimGas, destination.nativeSymbol, destination.name, "Claiming");

  const drop = useGasDrop(env);
  const dropOffered = deposit && drop?.available === true && env.receiver !== undefined;
  // The default follows the connected wallet's INJ while it is the recipient.
  // A typed address never moves it: following that re-priced the transfer
  // mid-typing and changed the amount under the user's eyes. The toggle is
  // right there for anyone sending to a wallet without INJ.
  const autoDrop = useRef(false);
  if (injBalance !== null && recipientText === null) autoDrop.current = injBalance < LOW_INJ;
  const wantDrop = dropOffered && (dropChoice ?? autoDrop.current);
  const quoteInput = {
    source,
    destination,
    amount,
    speed,
    gasDropFee: wantDrop && drop ? drop.dropFee : 0n,
    // A Solana recipient's account check decides the fee; wait for it.
    ready: !toSolana || recipient === null || solRecipient !== null,
  };
  const { quote, error: quoteError, loading } = useQuote(env, {
    ...quoteInput,
    recipientSetup,
    ...(forwardable ? { forward: !selfClaim } : {}),
  });
  // Circle's fee stays on show while the user has chosen to claim instead.
  const circleQuote = useQuote(env, {
    ...quoteInput,
    recipientSetup: needsAccount,
    forward: true,
    ready: quoteInput.ready && forwardable && selfClaim,
  }).quote;
  const deliveryFee = forwardable ? ((selfClaim ? circleQuote : quote)?.forwardingFee ?? null) : null;
  const lanes = useLanes(env);
  const slowLane = lanes.find((l) => l.domain === source.domain && l.status === "delayed");

  const fresh = quote !== null && amount !== null && quote.amount === amount;
  // While a re-quote for the same route and amount is in flight (the speed or
  // the gas drop changed), keep the last answer on screen, dimmed, instead of
  // blanking it. Display only: the button still waits for the fresh quote.
  const route = `${source.key}>${destination.key}`;
  const lastQuote = useRef<{ route: string; quote: NonNullable<typeof quote> } | null>(null);
  if (fresh) lastQuote.current = { route, quote };
  const held = lastQuote.current?.route === route && lastQuote.current.quote.amount === amount ? lastQuote.current.quote : null;
  // Not only while loading: a Solana recipient being checked holds the quote
  // back entirely (no key, not loading), and that path showed "0.00".
  const shown = fresh ? quote : held;
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
    const signature = await sendWithSolanaWallet(solanaWallet, plan, env.solanaRpc, (sig) => {
      record(source.domain, sig, solanaWallet.address);
      setBusy("confirming");
    });
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
    let hash: Hex;
    if (plan.approve && (await canBatch(provider, address, source))) {
      // One confirmation for both, where the wallet batches them atomically.
      setBusy("sending");
      hash = await sendBatch(provider, address, source, [plan.approve, plan.burn], () => setBusy("confirming"));
    } else {
      if (plan.approve) {
        setBusy("approving");
        const approval = await sendCall(provider, address, source, client, plan.approve);
        await client.waitForTransactionReceipt({ hash: approval, timeout: 180_000 });
      }
      setBusy("sending");
      hash = await sendCall(provider, address, source, client, plan.burn);
    }
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

  const readyLabel = deposit ? "Bridge to Injective" : `Bridge to ${destination.name}`;
  let action: { label: string; enabled: boolean; run?: () => void };
  if (fromSolana && !solAddress) {
    action = { label: "Connect a Solana wallet", enabled: Boolean(onConnectSolanaWallet), ...(onConnectSolanaWallet ? { run: onConnectSolanaWallet } : {}) };
  } else if (!fromSolana && !address) {
    action = { label: "Connect Wallet", enabled: Boolean(onConnectWallet), ...(onConnectWallet ? { run: onConnectWallet } : {}) };
  } else if (busy) action = { label: BUSY_LABEL[busy](source.name), enabled: false };
  else if (amount === null || amount === 0n) action = { label: "Enter an amount", enabled: false };
  else if (!recipient) {
    action = { label: deposit ? "Enter your Injective address" : toSolana ? "Enter a Solana wallet address" : "Enter a valid recipient", enabled: false };
  } else if (recipientProblem) action = { label: "Check the recipient", enabled: false };
  else if (toSolana && solRecipient === null && !held) action = { label: "Checking the recipient", enabled: false };
  else if (balance !== null && amount > balance) action = { label: `Not enough USDC on ${source.name}`, enabled: false };
  else if (fromSolana && solBalance !== null && solBalance < solNeeded) action = { label: "Not enough SOL for the network fee", enabled: false };
  else if (quoteError) action = { label: quoteError, enabled: false };
  else if (!fresh && !held) action = { label: "Getting a quote", enabled: false };
  else if (!fresh && held) {
    // A re-check for the same route and amount (a new recipient, say) is in
    // flight. The button keeps looking ready; a press waits for the answer and
    // sends only if it gives at least what was on screen when pressed.
    action = { label: readyLabel, enabled: true, run: () => setQueued(held.minReceived) };
  } else action = { label: readyLabel, enabled: true, run: () => void submit() };

  // A press made while re-checking: send once the fresh quote is in, unless
  // it is worse than what the user saw, or the form stopped being sendable.
  useEffect(() => {
    if (queued === null) return;
    if (!action.enabled) setQueued(null);
    else if (fresh && quote) {
      setQueued(null);
      if (quote.minReceived >= queued) void submit();
    }
  });

  // Short gas goes under the button's label, and only once the button could
  // be pressed: while it reads "Not enough USDC" that is the one thing to fix.
  // It warns rather than blocks, since a wallet with sponsored gas sends with none.
  // Claim gas is not here: it is spent later, on the destination, and is said
  // where the claim was chosen.
  const gasLine = action.enabled && !busy ? gasNote : null;

  // After a flip each panel slides in from where the other one was.
  const swap = flips > 0;
  const fee = shown ? shown.protocolFee + shown.forwardingFee + shown.bridgeFee : null;
  // The gas drop is bought, not charged, but it still comes out of the amount,
  // so the collapsed line counts it: "Fees up to 0.006" read as the whole cost
  // while the user received 0.50 less.
  const gasCost = shown && drop ? shown.gasDropFee : 0n;
  const upTo = shown && shown.protocolFee > 0n ? " up to" : "";
  /** Four decimals keep the line on one row; rounded UP, since it is a cap. */
  const cap = (v: bigint) => formatUsdc(((v + 99n) / 100n) * 100n, 4);
  const costLine =
    fee === null
      ? ""
      : gasCost > 0n
        ? fee === 0n
          ? `Gas ${formatUsdc(gasCost)} USDC`
          : // No "up to" here: with it the line wraps on a phone. The cap is
            // still on the Circle fee row and in "You receive at least".
            `Fees + gas ${cap(fee + gasCost)} USDC`
        : fee === 0n
          ? "No fees"
          : `Fees${upTo} ${cap(fee)} USDC`;
  const hasOptions = source.fastSource || (forwardable && selfClaimable) || (dropOffered && drop !== null);
  const setupHint = shown?.recipientSetup === true;
  const solHint = fromSolana;
  const expandable = hasOptions || setupHint || solHint;

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
                    Max
                  </button>
                ) : null}
              </span>
            ) : null
          }
        >
          <input
            className="iub-amount-input"
            inputMode="decimal"
            autoComplete="off"
            placeholder="0.00"
            aria-label="Amount of USDC"
            value={amountText}
            onChange={(e) => setAmountText(sanitizeAmountInput(e.target.value))}
          />
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
          // In the head row, opposite "To", so turning the gas drop on adds no height.
          extra={wantDrop && drop ? <span className="iub-plus">+ {formatEther(drop.dropWei)} INJ for gas</span> : null}
        >
          {loading && !shown ? (
            <span className="iub-skeleton iub-skeleton-amount" aria-label="Getting a quote" />
          ) : (
            // One element, updated in place: no key, no entrance animation and
            // no pending style, so a re-check behind the scenes never shows here.
            <span className={shown ? "iub-amount-value" : "iub-amount-value iub-dim"}>
              {/* Beside the pill there is room for ~12 digits on a phone. Rounded
                  down, so it is still a floor; the exact figure is in the details. */}
              {shown ? formatUsdc(shown.minReceived, shown.minReceived >= 1_000_000_000n ? 2 : 4) : "0.00"}
            </span>
          )}
        </Side>

        {slowLane ? (
          <Note tone="warn">
            Circle is slower than usual to approve transfers from {source.name} right now. Transfers are safe and still complete.
          </Note>
        ) : null}

        <Recipient
          deposit={deposit}
          destination={destination}
          fallback={defaultRecipient}
          text={recipientText}
          // Before the sending wallet is connected the button connects it, and
          // connecting fills this in; asking for an address first is a step
          // nobody needs.
          hidden={!sender}
          valid={recipient !== null && recipientProblem === null}
          onChange={setRecipientText}
          connect={
            toSolana && !solAddress && onConnectSolanaWallet ? { label: "Connect Solana wallet", run: onConnectSolanaWallet } : null
          }
        />
        {recipientProblem ? <Note tone="error">{recipientProblem}</Note> : null}

        {!deposit && !destination.forwarding ? (
          <Note>
            Circle does not deliver on {destination.name}. Once approved, you claim it there yourself, which needs {destination.nativeSymbol} for gas.
          </Note>
        ) : null}

        {/* Time and cost on one line; the choices that have a sensible default
            (speed, delivery, gas drop) open under it rather than crowding the form. */}
        <div className={details && expandable ? "iub-details iub-open" : "iub-details"}>
          {expandable ? (
            <button type="button" className="iub-details-toggle" aria-expanded={details} onClick={() => setDetails((d) => !d)}>
              <span className="iub-details-time">
                <IconClock /> About {formatDuration(eta)}
              </span>
              <span className="iub-details-fee">{costLine || "Options"}</span>
              <span className="iub-details-chevron">
                <IconChevron />
              </span>
            </button>
          ) : (
            // Nothing to choose and no quote to break down: just the time, with
            // no chevron promising a panel that would open empty.
            <div className="iub-details-toggle">
              <span className="iub-details-time">
                <IconClock /> About {formatDuration(eta)}
              </span>
            </div>
          )}
          <div className="iub-details-body">
            <div>
              <div className="iub-options">
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

        {/* Only when there is a choice: an option that cannot be picked is not
            shown greyed out, it is not shown. A Solana recipient without a USDC
            account has to be delivered to, so the switch goes. */}
        {forwardable && selfClaimable ? (
          <div className="iub-segment" role="radiogroup" aria-label="Delivery" data-active={selfClaim ? "1" : "0"}>
            <span className="iub-segment-indicator" aria-hidden />
            <button type="button" role="radio" aria-checked={!selfClaim} onClick={() => setClaimChoice(false)}>
              <span className="iub-segment-title">
                <IconParcel /> Delivered for you
              </span>
              <span className="iub-segment-sub">{deliveryFee !== null ? `${formatUsdc(deliveryFee, 6)} USDC, by Circle` : "By Circle, for a small fee"}</span>
            </button>
            <button type="button" role="radio" aria-checked={selfClaim} onClick={() => setClaimChoice(true)}>
              <span className="iub-segment-title">
                <IconWallet /> Claim it yourself
              </span>
              <span className="iub-segment-sub">
                {toSolana
                  ? `No fee, about ${formatAmount(claimSol, 9, 4)} SOL to claim`
                  : claimCost !== null && destination.kind === "evm"
                    ? `No fee, about ${formatGasAmount(claimCost)} ${destination.nativeSymbol} to claim`
                    : `No fee, you pay ${destination.nativeSymbol} gas on ${destination.name}`}
              </span>
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
        {/* No fee table: what arrives is in the To panel, the time and the
            total cost are on the line above, and the chosen option says who
            delivers. Only what is shown nowhere else gets a line. */}
        {setupHint ? <p className="iub-options-hint">Circle opens a USDC account for the recipient; it is in the delivery fee.</p> : null}
        {solHint ? (
          <p className="iub-options-hint">
            Sending from Solana also costs about {formatAmount(solNeeded, 9, 4)} SOL in network fees, most of it back after 5 days.
          </p>
        ) : null}
              </div>
            </div>
          </div>
        </div>

        {error ? <Note tone="error">{error}</Note> : null}

        <button
          type="button"
          className={[busy ? "iub-primary iub-primary-busy" : "iub-primary", gasLine ? "iub-primary-warn" : ""].join(" ").trim()}
          disabled={!action.enabled}
          onClick={action.run}
        >
          <span className="iub-primary-main">
            {busy || queued !== null || (loading && !shown && amount) ? <Spinner /> : null}
            {action.label}
          </span>
          {gasLine ? <span className="iub-primary-sub">{gasLine}</span> : null}
        </button>
        {/* Claim gas is spent later, on the destination, so it is a note under
            the button rather than on it; and only when it is actually short. */}
        {claimGasNote && action.enabled && !busy ? <p className="iub-after-cta">{claimGasNote}</p> : null}
      </div>

      <ChainPicker
        open={picking}
        network={env.network}
        chains={env.peerChains}
        direction={direction}
        selected={peer.key}
        balances={deposit ? balances.byChain : null}
        onPick={(key) => {
          setChainChosen(true);
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

/**
 * One panel per end: the amount, and beside it the asset pill. The token is
 * always USDC, so the pill is really the chain; it reads "USDC on Base" the
 * way a wallet would, and is the only chain control on the panel.
 */
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
  /** Right of the label: the balance, or what arrives besides the USDC. */
  extra?: ReactNode;
  className?: string | undefined;
  children: ReactNode;
}) {
  const pill = (
    <>
      <span className="iub-asset-logo">
        <UsdcLogo size={30} />
        <span className="iub-asset-badge">
          <ChainLogo chain={chain.key} name={chain.name} size={16} />
        </span>
      </span>
      <span className="iub-asset-text">
        <strong>USDC</strong>
        <span>{chain.name}</span>
      </span>
    </>
  );
  return (
    <div className={className ? `iub-side ${className}` : "iub-side"}>
      <div className="iub-side-head">
        <span className="iub-label">{label}</span>
        {extra}
      </div>
      <div className="iub-amount">
        {children}
        {locked ? (
          <div className="iub-asset iub-asset-locked">{pill}</div>
        ) : (
          <button type="button" className="iub-asset" onClick={onPick} aria-haspopup="dialog" aria-label={`USDC on ${chain.name}, change chain`}>
            {pill}
            <IconChevron />
          </button>
        )}
      </div>
    </div>
  );
}

function Recipient({
  deposit,
  destination,
  fallback,
  text,
  hidden,
  valid,
  onChange,
  connect,
}: {
  deposit: boolean;
  destination: Chain;
  /** The connected wallet that receives by default, if any. */
  fallback: string | null;
  text: string | null;
  /** Nothing to show until the user has typed something. */
  hidden: boolean;
  valid: boolean;
  onChange: (t: string | null) => void;
  connect: { label: string; run: () => void } | null;
}) {
  if (hidden && text === null) return null;
  // A well like From and To: "Send to" and its one action on top, the address
  // or the field filling the row below. Both states share the frame, so going
  // from one to the other never moves anything else on the form.
  const editing = !(text === null && fallback);
  const value = text ?? "";
  const action = !editing
    ? { label: "Change", tint: false, run: () => onChange("") }
    : fallback
      ? { label: "Use my wallet", tint: true, run: () => onChange(null) }
      : connect
        ? { label: connect.label, tint: true, run: connect.run }
        : null;
  const shown = !editing && fallback ? (deposit ? toInjAddress(fallback as Address) : fallback) : null;
  return (
    <div className={editing && !valid && value !== "" ? "iub-recipient iub-recipient-bad" : "iub-recipient"}>
      <div className="iub-recipient-head">
        <span className="iub-label">{shown ? "Send to your wallet" : "Send to"}</span>
        {action ? (
          <button type="button" className={action.tint ? "iub-action iub-action-tint" : "iub-action"} onClick={action.run}>
            {action.label}
          </button>
        ) : null}
      </div>
      <div className="iub-recipient-row">
        <ChainLogo chain={destination.key} name={destination.name} size={26} />
        {shown ? (
          <span className="iub-recipient-address" title={shown}>
            {midAddress(shown)}
          </span>
        ) : (
          <input
            className="iub-recipient-input"
            placeholder={
              deposit
                ? "Injective address, inj1... or 0x..."
                : destination.kind === "solana"
                  ? "Solana wallet address"
                  : `0x... address on ${destination.name}`
            }
            aria-label={`Recipient on ${destination.name}`}
            aria-invalid={!valid && value !== ""}
            value={value}
            spellCheck={false}
            autoComplete="off"
            onChange={(e) => onChange(e.target.value)}
          />
        )}
      </div>
    </div>
  );
}

/** More of an address than shortAddress, for a row that has the room: the ends people check. */
function midAddress(a: string): string {
  return a.length > 24 ? `${a.slice(0, 12)}…${a.slice(-8)}` : a;
}

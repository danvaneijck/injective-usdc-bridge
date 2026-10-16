import { type ReactNode, useState } from "react";
import { type Address, type Hex, formatEther, formatUnits, getAddress, isAddress, parseEther } from "viem";
import { erc20Abi } from "../abis.js";
import { toEvmAddress, toInjAddress } from "../address.js";
import { buildBurn } from "../burn.js";
import type { EvmChain } from "../chains.js";
import { CCTP_CONTRACTS, FINALITY, type Speed, USDC_DECIMALS } from "../constants.js";
import type { Direction } from "../quote.js";
import { expectedAttestMs } from "../timing.js";
import { ChainLogo, UsdcLogo } from "./ChainLogo.js";
import { formatDuration, formatUsdc, parseUsdc, sanitizeAmountInput, shortAddress } from "./format.js";
import { type Env, useGasDrop, useInjBalance, useLanes, useQuote, useUsdcBalance } from "./hooks.js";
import { IconChevron, IconFlip, Spinner } from "./icons.js";
import type { Eip1193Provider } from "./types.js";
import { friendlyError, sendCall } from "./wallet.js";

/** Under this much INJ, the gas drop starts ticked. */
const LOW_INJ = parseEther("0.01");

type Busy = null | "approving" | "sending";

export interface BridgeFormProps {
  env: Env;
  address: Address | null;
  provider: Eip1193Provider | null;
  onConnectWallet?: () => void;
  onSent(domain: number, txHash: Hex): void;
  defaultChain?: string;
  defaultDirection?: Direction;
}

export function BridgeForm({ env, address, provider, onConnectWallet, onSent, defaultChain, defaultDirection }: BridgeFormProps) {
  const [direction, setDirection] = useState<Direction>(defaultDirection ?? "deposit");
  const [peerKey, setPeerKey] = useState(defaultChain ?? "base");
  const [amountText, setAmountText] = useState("");
  const [speedChoice, setSpeedChoice] = useState<Speed | null>(null);
  const [dropChoice, setDropChoice] = useState<boolean | null>(null);
  const [recipientText, setRecipientText] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);
  const [busy, setBusy] = useState<Busy>(null);
  const [error, setError] = useState<string | null>(null);

  const peer = env.peerChains.find((c) => c.key === peerKey) ?? env.peerChains[0]!;
  const deposit = direction === "deposit";
  const source = deposit ? peer : env.inj;
  const destination = deposit ? env.inj : peer;
  const amount = parseUsdc(amountText);
  const speed: Speed = source.fastSource ? (speedChoice ?? "fast") : "standard";

  const recipient: Address | null =
    recipientText === null
      ? address
      : deposit
        ? toEvmAddress(recipientText)
        : isAddress(recipientText.trim(), { strict: false })
          ? getAddress(recipientText.trim())
          : null;

  const balance = useUsdcBalance(env, source, address);
  const injBalance = useInjBalance(env, deposit ? recipient : null);
  const drop = useGasDrop(env);
  const dropOffered = deposit && drop?.available === true && env.receiver !== undefined;
  const wantDrop = dropOffered && (dropChoice ?? (injBalance !== null && injBalance < LOW_INJ));
  const { quote, error: quoteError, loading } = useQuote(env, {
    source,
    destination,
    amount,
    speed,
    gasDropFee: wantDrop && drop ? drop.dropFee : 0n,
  });
  const lanes = useLanes(env);
  const slowLane = lanes.find((l) => l.domain === source.domain && l.status === "delayed");

  const fresh = quote !== null && amount !== null && quote.amount === amount;
  const fastEta = expectedAttestMs(env.network, source.domain, FINALITY.fast);
  const standardEta = expectedAttestMs(env.network, source.domain, FINALITY.standard);

  function flip() {
    setDirection(deposit ? "withdraw" : "deposit");
    setRecipientText(null);
    setSpeedChoice(null);
    setError(null);
  }

  async function submit() {
    if (!provider || !address || !quote || !recipient || !fresh) return;
    setError(null);
    try {
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
      const hash = await sendCall(provider, address, source, client, plan.burn);
      env.journal.add({ domain: source.domain, txHash: hash, address: address.toLowerCase(), at: Date.now() });
      void env.api.hint(source.domain, hash);
      setAmountText("");
      onSent(source.domain, hash);
    } catch (e) {
      setError(friendlyError(e));
    } finally {
      setBusy(null);
    }
  }

  let action: { label: string; enabled: boolean; run?: () => void };
  if (!address) action = { label: "Connect wallet", enabled: Boolean(onConnectWallet), ...(onConnectWallet ? { run: onConnectWallet } : {}) };
  else if (busy) action = { label: busy === "approving" ? "Approving USDC" : "Confirm in your wallet", enabled: false };
  else if (amount === null || amount === 0n) action = { label: "Enter an amount", enabled: false };
  else if (!recipient) action = { label: "Enter a valid recipient", enabled: false };
  else if (balance !== null && amount > balance) action = { label: `Not enough USDC on ${source.name}`, enabled: false };
  else if (quoteError) action = { label: quoteError, enabled: false };
  else if (!fresh) action = { label: "Getting a quote", enabled: false };
  else action = { label: deposit ? "Bridge to Injective" : `Bridge to ${destination.name}`, enabled: true, run: () => void submit() };

  if (picking) {
    return (
      <ChainList
        chains={env.peerChains}
        direction={direction}
        selected={peer.key}
        onPick={(key) => {
          setPeerKey(key);
          setSpeedChoice(null);
          setPicking(false);
        }}
        onClose={() => setPicking(false)}
      />
    );
  }

  return (
    <div className="iub-body">
      <Side
        label="From"
        chain={source}
        locked={!deposit}
        onPick={() => setPicking(true)}
        extra={
          address && balance !== null ? (
            <button type="button" className="iub-link" onClick={() => setAmountText(formatUnits(balance, USDC_DECIMALS))}>
              Balance {formatUsdc(balance)} <span className="iub-max">MAX</span>
            </button>
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
            <UsdcLogo /> USDC
          </span>
        </div>
      </Side>

      <div className="iub-flip-row">
        <button type="button" className="iub-flip" onClick={flip} aria-label="Swap direction">
          <IconFlip />
        </button>
      </div>

      <Side label="To" chain={destination} locked={deposit} onPick={() => setPicking(true)}>
        <div className="iub-amount iub-amount-out">
          <span className={quote && fresh ? "iub-amount-value" : "iub-amount-value iub-dim"}>
            {quote && fresh ? formatUsdc(quote.minReceived, 6) : "0.00"}
          </span>
          <span className="iub-token">
            <UsdcLogo /> USDC
          </span>
        </div>
        {wantDrop && drop ? <div className="iub-plus">+ {formatEther(drop.dropWei)} INJ for gas</div> : null}
      </Side>

      {slowLane ? (
        <div className="iub-note iub-note-warn">
          Circle is slower than usual to approve transfers from {source.name} right now. Transfers are safe and still complete.
        </div>
      ) : null}

      {source.fastSource ? (
        <div className="iub-segment" role="radiogroup" aria-label="Speed">
          <button type="button" role="radio" aria-checked={speed === "fast"} onClick={() => setSpeedChoice("fast")}>
            <strong>Fast</strong>
            <span>About {formatDuration(fastEta)}</span>
          </button>
          <button type="button" role="radio" aria-checked={speed === "standard"} onClick={() => setSpeedChoice("standard")}>
            <strong>Standard</strong>
            <span>About {formatDuration(standardEta)}, no Circle fee</span>
          </button>
        </div>
      ) : null}

      {dropOffered && drop ? (
        <label className="iub-check">
          <input type="checkbox" checked={wantDrop} onChange={(e) => setDropChoice(e.target.checked)} />
          <span>
            <strong>Add {formatEther(drop.dropWei)} INJ for gas</strong>
            <span className="iub-muted">
              {formatUsdc(drop.dropFee)} USDC.{" "}
              {injBalance === 0n ? "Your Injective wallet has no INJ yet." : "Pays for your first transactions on Injective."}
            </span>
          </span>
        </label>
      ) : null}

      <Recipient
        deposit={deposit}
        destination={destination}
        address={address}
        text={recipientText}
        valid={recipient !== null}
        onChange={setRecipientText}
      />

      {!deposit && !destination.forwarding ? (
        <div className="iub-note">
          Circle does not deliver on {destination.name}. Once approved, you claim it there yourself, which needs {destination.nativeSymbol} for gas.
        </div>
      ) : null}

      {quote && fresh ? (
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
          {quote.gasDropFee > 0n && drop ? (
            <div>
              <dt>{formatEther(drop.dropWei)} INJ for gas</dt>
              <dd>{formatUsdc(quote.gasDropFee)} USDC</dd>
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
            <dd>About {formatDuration(speed === "fast" ? fastEta : standardEta)}</dd>
          </div>
        </dl>
      ) : null}

      {error ? <div className="iub-note iub-note-error">{error}</div> : null}

      <button type="button" className="iub-primary" disabled={!action.enabled} onClick={action.run}>
        {busy || (loading && !fresh && amount) ? <Spinner /> : null}
        {action.label}
      </button>
    </div>
  );
}

function Side({
  label,
  chain,
  locked,
  onPick,
  extra,
  children,
}: {
  label: string;
  chain: EvmChain;
  locked: boolean;
  onPick: () => void;
  extra?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="iub-side">
      <div className="iub-side-head">
        <span className="iub-label">{label}</span>
        {extra}
      </div>
      {locked ? (
        <div className="iub-chain iub-chain-locked">
          <ChainLogo chain={chain.key} name={chain.name} />
          <span>{chain.name}</span>
        </div>
      ) : (
        <button type="button" className="iub-chain" onClick={onPick}>
          <ChainLogo chain={chain.key} name={chain.name} />
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
  address,
  text,
  valid,
  onChange,
}: {
  deposit: boolean;
  destination: EvmChain;
  address: Address | null;
  text: string | null;
  valid: boolean;
  onChange: (t: string | null) => void;
}) {
  if (text === null) {
    if (!address) return null;
    return (
      <div className="iub-recipient">
        <span className="iub-muted">To your wallet on {destination.name}</span>
        <span title={deposit ? toInjAddress(address) : address}>{shortAddress(deposit ? toInjAddress(address) : address)}</span>
        <button type="button" className="iub-link" onClick={() => onChange("")}>
          Change
        </button>
      </div>
    );
  }
  return (
    <div className="iub-recipient-edit">
      <input
        className={valid || text === "" ? "iub-input" : "iub-input iub-input-bad"}
        placeholder={deposit ? "inj1... or 0x... address on Injective" : `0x... address on ${destination.name}`}
        value={text}
        spellCheck={false}
        autoComplete="off"
        onChange={(e) => onChange(e.target.value)}
      />
      <button type="button" className="iub-link" onClick={() => onChange(null)}>
        Use my wallet
      </button>
    </div>
  );
}

function ChainList({
  chains,
  direction,
  selected,
  onPick,
  onClose,
}: {
  chains: EvmChain[];
  direction: Direction;
  selected: string;
  onPick: (key: string) => void;
  onClose: () => void;
}) {
  return (
    <div className="iub-body">
      <div className="iub-list-head">
        <span>{direction === "deposit" ? "Bridge from" : "Bridge to"}</span>
        <button type="button" className="iub-link" onClick={onClose}>
          Close
        </button>
      </div>
      <ul className="iub-chains">
        {chains.map((c) => (
          <li key={c.key}>
            <button type="button" aria-current={c.key === selected} onClick={() => onPick(c.key)}>
              <ChainLogo chain={c.key} name={c.name} size={28} />
              <span className="iub-chains-name">{c.name}</span>
              {direction === "deposit" && c.fastSource ? <span className="iub-chip">Fast</span> : null}
              {direction === "withdraw" && !c.forwarding ? <span className="iub-chip iub-chip-muted">Claim yourself</span> : null}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

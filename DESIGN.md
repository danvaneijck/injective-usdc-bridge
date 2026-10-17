# Injective USDC Bridge: design

Native USDC between Injective and other chains over Circle CCTP V2. It replaces
the Choice v1 bridge and is built to be embedded in any Injective app (Choice
v2, the sprout launchpad), plus a standalone site.

## Decisions (2026-10-16)

| Topic | Decision |
| --- | --- |
| Routes | Injective on one end only. No EVM to EVM. |
| Fee | None today. `Quote.bridgeFee` exists and is always 0; see [Fees](#fees). |
| Distribution | Public npm package `injective-usdc-bridge`. |
| Robinhood Chain | Out. No native USDC and no CCTP there; bridges deliver Paxos USDG. |
| Delivery | Anyone can complete every burn: plain burns use `destinationCaller = 0`; gas-drop burns pin it to `BridgeReceiver`, whose `relay()` is permissionless. |
| Gas drop | Kept (Dan, 2026-10-16). Opt-in on deposits, priced near cost, through `BridgeReceiver`. |

## Architecture

```text
injective-usdc-bridge (npm)          core: no React, no wallet code
  chains / quote / burn / status     ├── used by the widget in the browser
  iris client / message decode       └── used by bridge-service in Node
        │
        ├── injective-usdc-bridge/react   <Bridge/>, <TransferStatus/>  (phase 2)
        │        hosts: Choice v2, launchpad, the standalone site
        │
        └── bridge-service                indexer + Iris poller + relayer + API  (phase 1)
```

The service, not the browser, is the source of truth. The widget reports the
burn it just made as a hint so the service looks sooner, but the service finds
every burn from chain data whether or not that hint arrives.

## Who submits the mint

| Direction | Destination | Mint submitted by |
| --- | --- | --- |
| Withdraw (Injective to X) | Circle forwards to X | Circle's Forwarding Service, fee taken from the transfer (~0.05 USDC on L2s, ~1.04 to Ethereum, ~0.13 to Solana as of 2026-10-16) |
| Withdraw | No forwarding (Plasma) | bridge-service from a per-chain float, or the user via a Claim button |
| Deposit (X to Injective) | Injective | bridge-service. Circle does not forward to Injective (`Destination domain not supported for forwarding`) |

Forwarding is asked for with hook data `cctp-forward` v0 (`FORWARD_HOOK_DATA`).
Iris then returns two undocumented fields on the message, `forwardState` and
`forwardTxHash` (the destination mint), which `resolveTransfer` passes through
for display. `forwardState` read `CONFIRMED` seconds after the mint and
`COMPLETE` 15 minutes later, so neither value is treated as meaningful.
Delivery is still decided by `usedNonces`.
Circle will not forward a burn with a `destinationCaller` set, which is one more
reason every burn here is permissionless.

Backstop: any `ready` transfer the expected party has not minted after a grace
period (forwarded: 10 min, ours: 2 min) is minted by bridge-service if the
destination gas is under a set share of the amount, otherwise surfaced to the
user as a claim.

## Rules carried over from v1

Each one maps to a real incident in the v1 history.

1. **Destination chain decides delivery.** `usedNonces(eventNonce) != 0` on the
   destination is the only "delivered". Iris `complete` means signed. A job row
   saying `failed` is not evidence of stuck money either.
2. **Discover burns from chain data.** v1's relay table missed 9 of 13 stranded
   sponsored transfers because the browser POST never landed. The indexer reads
   `DepositForBurn` on every source chain and keeps Injective-bound ones, plus
   every Injective burn.
3. **Nothing only we can complete.** v1 sponsored burns were pinned to a
   receiver that reverted when the fee exceeded the amount, and could be
   paused; 3 burns under the sponsor fee are locked forever. `BridgeReceiver`
   relays for anyone, cannot be paused (only drops can), and never reverts on
   economics.
4. **Refuse burns that cannot cover their fees** before signing
   (`quoteTransfer` throws).
5. **Calibrated log spans, never trust an empty result.** Public RPCs truncate
   `eth_getLogs` silently (`arb1` ~5k blocks, Injective sentry ~8k). A span
   enters `logRpcs` only after a split-consistency check. Uncalibrated chains
   use small spans and two endpoints.
6. **Ordered RPC lists with failover on transport errors only**; a JSON-RPC
   error is an answer.
7. **Injective tip floor of 1 gwei** (`feeOverrides`), or MetaMask prices the
   tx against the 150M block gas limit and says "not enough INJ".
8. **Expired messages**: `expirationBlock` passed, so call Iris `reattest`, then refetch.
9. **Iris outage is a lane state, not a user's problem.** On 2026-09-01 Iris
   stopped attesting all Injective burns for hours. The service tracks
   time-since-last-attestation per source domain and the UI shows "Circle is
   delayed" instead of "your transfer is stuck".
10. **One transfer state machine** (`resolveTransfer`) for every route. v1 had
    three hooks totalling about 2.5k lines duplicating it.
11. **Read-after-write lag**: right after a mint, `usedNonces` can still read
    0 for a few seconds. Re-read before retrying a mint.
12. **Polygon `receiveMessage` needs a 250k gas limit** (`receiveGasLimit`).
13. **Iris is fronted by a CDN that 403s some User-Agents**; the Node client sends one.

## Chains (verified 2026-10-16)

`npm run verify-chains` checks chain id, USDC symbol and decimals, and
`MessageTransmitterV2.localDomain()` for every RPC, and that Iris quotes both
directions. 47/47 mainnet, 7/7 testnet.

Carried from v1: Ethereum, Base, Arbitrum, OP, Polygon, Avalanche, Linea,
Unichain, Sonic, World Chain, Solana. New: HyperEVM, Monad, Sei, Plasma, Ink.

Notes:

- World Chain USDC is printed with an invalid checksum in Circle's docs and in
  v1. The registry has the corrected form and a test enforces EIP-55.
- Linea Fast Transfer costs 13 bps; the widget must show Fast vs Standard cost
  rather than defaulting blindly.
- Not yet in the registry: Arc, Codex, XDC, Plume, Morph, Cronos, X Layer,
  Starknet, Stellar. Adding an EVM chain is one registry entry plus a passing
  `verify-chains`.

## Fees

Today every route is free on our side. To add a fee later without breaking
integrators:

- **Deposits**: the burn's `mintRecipient` becomes an Injective receiver
  contract that mints, keeps `feeBps` (capped by an immutable maximum), and
  pays the user in the same call. `relay()` must stay permissionless and must
  never revert on a fee shortfall: it pays out everything instead.
- **Withdrawals**: a small router on Injective that takes the fee and calls
  `depositForBurnWithHook`.
- **Callers**: `Quote.bridgeFee` is already rendered and subtracted from
  `minReceived`, so UIs need no change.

## BridgeReceiver (gas drop)

`contracts/src/BridgeReceiver.sol`, 8 KB, 28 Foundry tests including a
conservation fuzz (every minted unit is paid, accrued as a fee, or escrowed).

**Mainnet: `0xcA5A96ECF72B3656eF7cF60BDAA42FCdb218cd4A`**, deployed 2026-10-16
(tx `0xad073691…60a1`) by `script/DeployBridgeReceiver.s.sol` and verified on
Blockscout. Owner: the Choice Safe `0xE176FeE8…AA1d` (2-of-3, the same Safe as
Choice v2 and the pad). It deployed configured, so the Safe signed nothing:

| | |
| --- | --- |
| Drop | 0.02 INJ for 0.50 USDC, fixed (v1's offer; Dan 2026-10-16) |
| `minDropFee` | 0.50 USDC, so the price cannot be lowered without the Safe |
| Ceilings (immutable) | `maxDropWei` 0.1 INJ, `maxDropFee` 2 USDC |
| `sweeper` | relayer `0xeEB5b86A…1566` (key only on the server) |
| `pricer` | none |
| `feeBps` | 0 |

0.50 USDC covers 0.02 INJ until INJ passes $25; the Safe raises the fee if it
gets close (a burn already in flight then skips its drop and is refunded).

- A gas-drop deposit burns with `mintRecipient = destinationCaller =
  BridgeReceiver` and hook `abi.encode(bytes4 "IUB1", address recipient,
  uint256 maxDropFee)`. `encodeGasDropHook` in the package builds it; a shared
  test vector pins TS and Solidity to the same bytes.
- `relay(message, attestation)` is permissionless. It mints, pays the user,
  and sends `dropWei` INJ from the float for `dropFee` USDC.
- A drop is skipped and not charged when drops are paused or disabled, the
  fee is above the user's `maxDropFee`, the float is short, the fee would eat
  the amount, or the recipient refuses INJ. Delivery still happens.
- Blacklisted recipients and malformed hooks are escrowed; the owner can
  reassign escrow only for non-EVM senders (e.g. Solana keys).
- Pricing: fixed by the owner today. The contract also supports a `pricer`
  key that sets `dropFee` within `[minDropFee, maxDropFee]` (Dan chose not to
  use one: a moving price was more complexity than ~1 drop a day justifies).
  `maxDropWei` and `maxDropFee` are immutable ceilings. A pricer can pause
  drops but only the owner unpauses.
- Fees accrue in `accruedFees`; the `sweeper` (refill keeper) can sweep only
  those, only to itself, then swaps to INJ and refills the float.
- `feeBps` (bridge fee) exists with an immutable 50 bps ceiling, set to 0.
- v1's `GasDropReceiver` stays live until the new widget ships; the service
  relays both.

## Paying for gas without top-ups

Measured 2026-10-16 on Injective: a deposit mint uses ~560k gas at the 0.16
gwei base fee, about 0.00009 INJ (~$0.0008 at $9.22). ⚠️ Injective bills
`gasLimit × maxFeePerGas` up front and refunds nothing, so the relayer pins
the fee to base fee + 12.5% with no tip. The limit is the estimate +50%, at
least 800k: Choice v2 measured `eth_estimateGas` under-reporting on Injective,
and other relayers send these mints at 768k for 562k used. At that cost 1 INJ
still covers ~6,000 deposits.

The real recurring cost is the gas drop (0.02 INJ, ~$0.18, per user), and
users pay 0.50 USDC for it. v1's drop ran at about one a day (its receiver
`0xbe7a…54b4` made 167 transactions May to October 2026). Each drop nets about
+0.034 INJ once its fee is swapped back, which also pays for relaying plain
deposits.

**The keeper** (`service/src/keeper.ts`, relay mode on mainnet, every 3 min)
signs with the relayer key, which is BridgeReceiver's `sweeper`:

- It acts when the float drops under 0.04 INJ (two drops; target 0.06) or the
  relayer under 0.03 INJ (target 0.05). The relayer is refilled first: it
  delivers everyone's deposits, while an empty float only skips and refunds
  drops. Surplus relayer INJ funds the float without a swap.
- It prices what is missing with the chain's oracle precompile (`0x…67`,
  PythPro feed 46 INJ/USD, the feed Choice v2's api ratified; refused when over
  5 minutes old), sweeps just enough fees to itself, and swaps at least 0.5 and
  at most 5 USDC a tick to native INJ.
- Swap path: Choice's aggregator (`0xa705…37c9`, 1.1.0) on a route from
  Choice v2's `/route` api, so refills follow liquidity across Choice, Pumex
  and Helix. Dan asked for this over a pinned pool (2026-10-16). The api's
  calldata is decoded and refused unless it is `execute` on the pinned
  aggregator, USDC in, native INJ out, the exact amount, the relayer as
  recipient, no fee, no adapter step, a deadline within the hour, and a
  `minimumReceive` at least 97% of the oracle value. The aggregator enforces
  that minimum on what the recipient receives, so a hostile api answer can
  cost at most that 3% of one swap. Permit2 grants are exact and last 15
  minutes. Gas is twice the estimate, at least 1.5M for the swap.
- Problems (stale oracle, fees under the minimum swap, a refused route) show
  in `/v1/health` under `keeper` and are logged at most hourly.
  `npm run keeper-dryrun` does a whole pass read-only against mainnet.
- Seed once: ~0.05 INJ to the receiver and ~0.05 INJ to the relayer. It is
  working capital, not a subsidy: INJ leaves at relay, before the fee can be
  swapped back.

No new fee on plain deposits: the margin on opt-in drops funds the relays.
If drops turn out rare, `feeBps` (capped at 50) or a flat relay fee in
BridgeReceiver is the lever.

## Deploy (Choice server)

The service runs beside Choice v2 mainnet as its own compose project
`choice-v2-mainnet-bridge` (choice_v2_deploy #29) behind
`bridge-api.choice.exchange` (choice_docker_env #46). Image:
`ghcr.io/danvaneijck/injective-usdc-bridge-service:sha-*`, published by this
repo's CI, public. Reads and sends use the box's local node; log scans never
do, because it answers pruned ranges with an empty list.

## bridge-service (phase 1)

`service/`, one Node process. `MODE=shadow` indexes and tracks but never
sends; `MODE=relay` also mints deposits. Config in `service/.env.example`.

- **Indexer** (`indexer.ts`): per chain cursor; `DepositForBurn` from
  `TokenMessengerV2`. Keeps every burn on Injective and every burn elsewhere
  whose `destinationDomain` is 29 (not an indexed topic, so filtered after
  decode). Each window is fetched entirely from one endpoint, chunked by that
  endpoint's proven span; on any failure the whole window is refetched from the
  next endpoint, never stitched across endpoints.
- **Classifier** (`classify.ts`): `plain`, `forward`, `gas_drop` (our
  receiver), `legacy_gas_drop` (v1 receivers v4 `0xbe7a…54b4` and v3
  `0xCeD8…7Ec3`), `pinned_other` (someone else's caller; never touched).
- **Tracker** (`tracker.ts`): Iris then destination `usedNonces` (EVM) or the
  `used_nonce` PDA (Solana). Pairs several burns in one tx with their own
  messages. Backoff follows each source chain's normal attestation time.
  Expired messages get one `reattest` per 10 minutes.
- **Relayer** (`relayer.ts`): deposits into Injective only, after a grace
  period (15 s plain, 120 s for v1-pinned burns, which v1's backend relays
  itself). Re-reads `usedNonces`, simulates, then sends with the 1 gwei tip
  floor. A revert after someone else's mint is recorded as delivered, not as
  an error. 8 attempts with backoff, then it logs for a human.
- **API** (`api.ts`, Hono): `GET /v1/transfers?address=` (0x or inj1;
  depositor or recipient), `GET /v1/transfers/:domain/:tx`,
  `POST /v1/transfers/hint`, `GET /v1/health` (per-lane indexer and Iris lag,
  relayer balance; 503 when not ok). Every `ready` transfer carries a `claim`
  call `{chainId, to, data}` a UI can send as-is.
- **Storage**: SQLite (WAL), not Postgres: one writer process, and every row
  can be rebuilt from chain data by rewinding a cursor. Tests run against the
  real database instead of mocks.
- **Shadow first**: run it against live traffic while v1 is still the UI. In
  relay mode it also completes v1 deposits, since it does not care which UI
  made the burn.
- **Not yet**: withdrawal backstop mints on peer chains (Plasma, or when
  Circle's forward stalls), alerts beyond the health endpoint.

## Widget (phase 2)

- `injective-usdc-bridge/react` subpath, React 18 and 19 peer.
- Host passes an EIP-1193 provider and the connected address. Keplr and Leap
  users go through their `.ethereum` providers, as in v1. No wagmi
  requirement, because the three hosts use ethers v5, ethers v6 and viem.
- Theming through CSS variables (`--iub-*`), shipped stylesheet, no Tailwind
  dependency in the host.
- Transfers list = service API merged with a multi-entry local journal (never
  a single slot). The confirm button is disabled while a burn is in flight.
- Solana support adds no Solana SDK: the burn and the transaction are built
  with the noble/scure libraries the package already uses (see Solana below).
- UI copy has no em dashes.

**Built 2026-10-17** (`packages/bridge/src/react`, Dan chose: own site first,
Choice v2 look, themeable):

- Form: From and To panels with Injective locked on one side and a flip
  button; chain list with Fast and "Claim yourself" chips; Fast or Standard
  with Circle's usual time; the gas drop, ticked by default when the
  recipient holds under 0.01 INJ; recipient as 0x or inj1; fees (Circle fee,
  delivery, gas drop, at least received, time). A quote is kept with the
  route, speed and amount it was made for, so a stale one is never shown or
  signed. Approvals are exact. Sends go through the host's provider, switching
  or adding the chain; on Injective the fee is pinned and the gas padded.
- Tracking: three steps (sent, Circle approval with a countdown, arrived),
  a lane banner when Circle is slow on the source chain, and a Complete
  button when a transfer has sat attested for 3 minutes (at once for
  withdrawals Circle does not deliver, e.g. Plasma).
- Activity: the service's list for the wallet plus journal entries it has
  not returned yet, each looked up by hash (which makes the service index it).
- Chain logos are web3icons' brand-colour marks (MIT, see
  `packages/bridge/THIRD_PARTY_NOTICES.md`) for 16 chains, and Solana's own
  current logomark (solana.com/branding, unaltered on black, as its brand
  rules ask), rendered as `<img>` data URLs in circles; an unknown chain gets
  a lettered disc. Order everywhere is the registry's: Injective, Solana,
  HyperEVM (the most used, 2026-10-17), then the rest.
- Withdrawals to a chain Circle delivers on offer a choice (Dan, 2026-10-17):
  "Delivered for you" (the default, Circle's fee shown) or "Claim it
  yourself" (no fee; the transfer page and Activity offer the claim the
  moment Circle approves, one transaction with the destination's gas). Fees
  it skips: about 0.05-0.08 USDC to L2s, 0.13 to Solana, about 1 USDC to
  Ethereum. To Solana the claim may have to open the recipient's USDC
  account, which needs its owner, so it is offered when that account exists
  or the recipient is the connected Solana wallet. Choosing it checks the
  claimer's gas on the destination (250k gas on EVM chains; 0.001 SOL, 0.0032
  when opening the account) and warns, as for sending.
- Before signing on an EVM chain the form reads the sender's native balance
  and warns (never blocks: sponsored-gas wallets send with none) when it is
  under approve plus burn at today's gas price (600k gas, measured on
  Injective).
- Chains are picked from a sheet that slides up over the widget (never over
  the host page, so an embedding app's stacking stays out of it): search,
  arrow keys, Escape, focus kept inside. Motion is CSS only and collapses under
  `prefers-reduced-motion`.
- The site (`apps/site`) adds EIP-6963 wallet discovery, `/tx/<domain>/<hash>`
  pages, a `/status` page that reads `/v1/health` (every chain's sync, in-flight
  transfers, auto-delivery and the gas-drop float, refreshed every 15 s), and
  is served by the bridge service itself (`SITE_DIR`): hashed
  assets cached for a year, the page uncached, CSP with
  `frame-ancestors 'none'` against clickjacking (scripts: self plus the
  Cloudflare analytics beacon its edge injects). `npm run smoke` drives it in
  real Chrome with a read-only stand-in wallet.
- It must only run alongside `MODE=relay`: a gas-drop deposit can only be
  completed through BridgeReceiver, and a plain deposit's user would need INJ
  to finish it themselves.

## Phases

| Phase | Scope |
| --- | --- |
| 0 | **Done**: core package, verified registry, BridgeReceiver, 30 TS + 27 Foundry tests. |
| Gate | **Passed 2026-10-16.** $1 Injective to Base with forwarding (`npm run live-withdraw`): burn `0x9a156fc5…f09f` at 09:45:21Z, Circle's relayer `0xb756…5b5e` minted `0xcb42b1f0…b862` on Base at 09:45:31Z (10 s, 186k gas). 0.945948 USDC received after a 0.054052 forwarding fee. |
| 1 | **Live.** bridge-service shadow-run on mainnet 2026-10-16: 6 h backfill on 16 chains, every lane healthy, completeness check matched all 41 Injective arrivals to indexed burns. Shadow at bridge-api.choice.exchange from 2026-10-16; `MODE=relay` with the keeper from 2026-10-16 22:25Z (receiver and relayer seeded 0.05 INJ each). |
| 2 | **Widget live** on bridge.choice.exchange from 2026-10-16 22:26Z, smoke-tested in Chrome against production. Next: Choice v2 and the launchpad, replacing their jumper.xyz links. |
| 3 | **Solana built 2026-10-17** (see Solana), with the Solana claim and the deposit refund. Next: HyperCore direct deposit via Circle's `CctpForwarder` on HyperEVM; a wrong recipient or caller there strands funds permanently, so it gets its own tests. |
| 4 | Standalone site with `/tx/:domain/:hash` tracking pages; retire the v1 bridge UI. |

## Solana

Both directions, built 2026-10-17 (Dan: both together, public RPC for now).

- **Injective to Solana**: an ordinary Injective burn whose `mintRecipient`
  is the recipient wallet's USDC associated token account, never the wallet
  (a burn naming the wallet is unusable). Circle always delivers (about 0.13
  USDC). When the account does not exist, the hook asks Circle to create it:
  version 0, Circle data length 33, byte 32 = 1, bytes 33-65 the owner, fee
  quoted with `includeRecipientSetup=true` (about 0.29 USDC). The widget
  checks a typed recipient on chain and refuses a token account, the classic
  way to strand a Solana transfer. No Solana wallet is needed to receive.
- **Solana to Injective**: `deposit_for_burn` (or `_with_hook` for the gas
  drop, pinned to BridgeReceiver exactly as on EVM chains), signed by the
  user's Solana wallet and a one-off event account. The transaction is
  serialised here (legacy format) and checked byte for byte against
  @solana/web3.js in tests; a real mainnet burn is rebuilt byte for byte; it
  is simulated before signing, which also sizes compute and refuses a burn
  that would fail. The user pays about 0.0029 SOL (0.0034 with the hook),
  mostly the event account's rent. Our relayer mints on Injective as for EVM
  deposits.
- **Indexing**: every Solana burn to Injective lists TokenMessengerMinter's
  `remote_token_messenger` account for domain 29 (`2tFfjwfz…KYvng`), so its
  signature history is a complete, small index (about 1 burn a day in
  October 2026; Injective-to-Solana mints list it too and are skipped). The
  cursor never passes a burn it could not read. Solana now has version 1
  transactions, which @solana/web3.js 1.x cannot read; the indexer asks the
  RPC for them and falls back to Circle's decoding for any layout it does not
  know. Signatures and wallets are base58 and case-sensitive: the service
  lowercases hex only.
- **Wallets**: the widget takes a `solanaWallet` shaped after Wallet
  Standard's sign methods (wire bytes in and out); the site finds Phantom,
  Solflare, Backpack and MetaMask through Wallet Standard.
- **Claiming on Solana** (built 2026-10-17): when Circle's forward fails, or
  for a burn made without forwarding (v1 made those; `buildBurn` still can
  with `forward: false`, the widget never does), any Solana wallet can send
  the mint itself: `receive_message` with TokenMessengerMinter's accounts
  after it, ported from v1 and rebuilt byte for byte from a real mainnet mint
  in tests. It opens the recipient's USDC account first (CreateIdempotent)
  when that is missing and the owner is known. The payer pays the nonce
  account's rent (about 0.00095 SOL), plus 0.002 SOL when it opens the USDC
  account. Inline the transaction is about 1260 bytes, over Solana's 1232, so
  it is a v0 transaction loading the 14 fixed accounts from the table v1
  published (`2LLzhRZ…NWX5`, `SolanaChain.receiveLookupTable`). The table is
  read from chain and only accounts actually found in it load from it;
  tables are append-only, so a stale or foreign table can only fail the claim
  (the size check refuses it), never point it at other accounts. The v0
  compiler is checked byte for byte against @solana/web3.js. The service
  sends `solanaClaim` (message and attestation) on ready transfers to Solana;
  the card's button appears at once for unforwarded burns and after 3 minutes
  for forwarded ones, as on EVM chains.
- **Deposit refund** (built 2026-10-17): a burn from Solana parks about
  0.0028 SOL of rent in its event account. Circle's `reclaim_event_account`
  returns it to the rent payer (the burning wallet, in our burns) from 5 days
  after the burn, given Circle's attestation. The indexer records each burn's
  event account (`event_account` column, added in place on existing
  databases), the service sends `solanaRefund` once the burn is attested,
  and the widget reads the accounts on chain: a "SOL deposit" line until it
  is due, a Reclaim button on the transfer once it is, and a banner in
  Activity summing every deposit the connected wallet can take back. Of the
  burns to Injective older than 5 days found on 2026-10-17, none had been
  refunded.
- **Checked on mainnet without funds**: `npm run verify-solana-claims`
  simulates refunds of real old event accounts (Circle's program verifies the
  attestation and closes the account), rebuilds a recent real
  `receive_message` and simulates ours through the table, which must stop at
  the used nonce. Live: `live-withdraw --to solana --no-forward`, then
  `live-solana-claim`, and `live-solana-refund` 5 days after a burn.

## Open

- Choice v2 and the launchpad embed the widget.
- Record who minted each deposit (`minted_by` is "unknown" unless we relayed it).

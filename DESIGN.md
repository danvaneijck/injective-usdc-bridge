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

`contracts/src/BridgeReceiver.sol`, 8 KB, 27 Foundry tests including a
conservation fuzz (every minted unit is paid, accrued as a fee, or escrowed).

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
- Pricing: a `pricer` key (the service) sets `dropFee` within
  `[minDropFee, maxDropFee]`; `minDropFee` is the owner's anti-farming floor;
  `maxDropWei` and `maxDropFee` are immutable ceilings. The pricer can pause
  drops but only the owner unpauses.
- Fees accrue in `accruedFees`; the `sweeper` (refill keeper) can sweep only
  those, only to itself, then swaps to INJ and refills the float.
- `feeBps` (bridge fee) exists with an immutable 50 bps ceiling, set to 0.
- Owner: a Safe multisig before the float is seeded (v1 mainnet v3 sat
  unfunded for that reason).
- Not yet deployed. v1's `GasDropReceiver` stays live until the new widget
  ships; the service relays both.

## bridge-service (phase 1)

- **Indexer**: per chain cursor; `DepositForBurn` from `TokenMessengerV2`. Keeps
  every burn on Injective and every burn elsewhere whose `destinationDomain` is
  29 (it is not an indexed topic, so filter after decode). Confirmations lag
  and a reorg margin per chain.
- **Poller**: Iris for `attesting` rows, kept well under Iris' 35 req/s limit
  (going over blocks the IP for 5 minutes), then destination `usedNonces`.
- **Relayer**: mints deposits on Injective from a hot key with a small INJ
  float and alerts below threshold. Backstop mints for withdrawals as above.
- **API**: `GET /v1/transfers?address=` (0x or inj1; depositor or recipient),
  `GET /v1/transfers/:domain/:tx`, `POST /v1/transfers/hint`, `GET /v1/health`
  (per-lane Iris lag, relayer float).
- **Storage**: Postgres. It is reconstructible from chain data, so the cursor
  can be rewound to rebuild it.
- **Shadow first**: run it against live traffic while v1 is still the UI. It
  will also find and mint v1 strands into Injective, since it does not care
  which UI made the burn.

## Widget (phase 2)

- `injective-usdc-bridge/react` subpath, React 18 and 19 peer.
- Host passes an EIP-1193 provider and the connected address. Keplr and Leap
  users go through their `.ethereum` providers, as in v1. No wagmi
  requirement, because the three hosts use ethers v5, ethers v6 and viem.
- Theming through CSS variables (`--iub-*`), shipped stylesheet, no Tailwind
  dependency in the host.
- Transfers list = service API merged with a multi-entry local journal (never
  a single slot). The confirm button is disabled while a burn is in flight.
- Solana code is a lazy chunk.
- UI copy has no em dashes.

## Phases

| Phase | Scope |
| --- | --- |
| 0 | **Done**: core package, verified registry, BridgeReceiver, 30 TS + 27 Foundry tests. |
| Gate | A $1 live withdrawal Injective to Base with forwarding (`npm run live-withdraw`), to confirm Circle mints for Injective-sourced burns end to end. |
| 1 | bridge-service in shadow mode, then relaying. |
| 2 | Widget, integrated in Choice v2 (viem, easiest), then the launchpad (replacing the jumper.xyz link). |
| 3 | Solana legs (port v1 `solanaCctp.ts`; forwarding needs the recipient's USDC ATA and the extended hook for ATA creation). HyperCore direct deposit via Circle's `CctpForwarder` on HyperEVM; a wrong recipient or caller there strands funds permanently, so it gets its own tests. |
| 4 | Standalone site with `/tx/:domain/:hash` tracking pages; retire the v1 bridge UI. |

## Open

- Deploy parameters for BridgeReceiver: `dropWei`, `minDropFee`, the two
  ceilings, and which Safe owns it.

# bridge-service

Finds every CCTP burn to or from Injective by reading the chains, tracks each
one until the destination chain shows the mint, mints deposits into Injective,
and serves the transfer API the widget reads.

```sh
cp .env.example .env          # MODE=shadow to start
npm start                     # from service/
```

Design and the reasons behind each rule: [`../DESIGN.md`](../DESIGN.md#bridge-service-phase-1).

## Modes

- `shadow`: indexes, tracks and serves the API, never sends a transaction.
  Logs `shadow: would relay` for each deposit it would have minted.
- `relay`: also mints attested deposits into Injective with
  `RELAYER_KEY_FILE`. Keep the relayer wallet small; watch `relayer.low` in
  `/v1/health`. On mainnet the refill keeper runs too: it swaps gas-drop fees
  to INJ through Choice's aggregator and tops up BridgeReceiver's float and
  the relayer, so neither needs topping up by hand (`KEEPER=off` to stop it;
  `keeper` in `/v1/health` says what it last saw). `npm run keeper-dryrun`
  runs one pass read-only against mainnet.

## API

| Route | |
| --- | --- |
| `GET /v1/transfers?address=` | 0x or inj1; transfers it sent or receives, newest first. `next` pages with `before`. |
| `GET /v1/transfers?tx=` | Transfers in a tx found by its hash alone (0x, bare hex, or a Solana signature). An unseen hash is looked up on every chain once per 30 s. |
| `GET /v1/transfers/:domain/:tx` | Transfers in one source tx; indexes it on demand if unseen. |
| `POST /v1/transfers/hint` | `{sourceDomain, txHash}` right after a burn, so tracking starts at once. |
| `GET /v1/health` | Per-chain indexer and attestation lag, relayer balance. 503 when not ok. |

The API is public and read-mostly; `hint` and on-demand lookups each cost one
RPC call (a `?tx=` miss, one per EVM chain), so put the service behind the
usual reverse-proxy rate limit.

A transfer's `phase` is `not_found`, `attesting`, `ready`, `expired` or
`delivered`. `delivered` always comes from the destination chain. A `ready`
transfer carries `claim: {chainId, to, data}`, a call anyone can send to
complete it.

## Checks

```sh
npm test
DB_PATH=./data/bridge.sqlite npm run completeness   # every Injective arrival matched to an indexed burn
```

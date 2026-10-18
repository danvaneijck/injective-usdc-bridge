# injective-usdc-bridge

Native USDC between Injective and other chains over Circle CCTP V2, built to be
embedded in any Injective app.

| Path | What |
| --- | --- |
| [`packages/bridge`](packages/bridge) | npm package `injective-usdc-bridge`: chain registry, fee quotes, burn builders, Circle attestation client, delivery status; `injective-usdc-bridge/react` is the widget |
| [`service`](service) | bridge-service: indexes every burn to or from Injective, tracks it to the mint, mints stuck deposits, keeps its own gas topped up; serves the API and the site |
| [`apps/site`](apps/site) | The standalone site (bridge.choice.exchange): the widget plus a wallet picker, `/tx/<domain>/<hash>` tracking pages and a `/status` page |
| [`contracts`](contracts) | `BridgeReceiver`: Injective-side relay for deposits that include an INJ gas drop |
| [`DESIGN.md`](DESIGN.md) | Architecture, rules learned from the previous bridge, phases |

## Chains

Injective on one end of every route. The other end: Ethereum, Base, Arbitrum,
OP Mainnet, Polygon, Avalanche, Linea, Unichain, Sonic, World Chain, HyperEVM,
Monad, Sei, Plasma, Ink, Solana.

```sh
cd packages/bridge
npm run verify-chains   # read-only check of every chain and RPC against the live chains
```

## Usage

```ts
import {
  IrisClient, buildBurn, chainByKey, injective, quoteTransfer, resolveTransfer, createChainReader,
} from "injective-usdc-bridge";

const iris = new IrisClient({ network: "mainnet" });
const route = { source: injective("mainnet"), destination: chainByKey("mainnet", "base")! };

// Withdrawals ask Circle's Forwarding Service to mint on the destination.
const quote = await quoteTransfer({ iris, route, amount: 25_000_000n }); // 25 USDC
const plan = buildBurn({ network: "mainnet", route, quote, recipient: "0x…" });
// send plan.approve (if present) and plan.burn with the user's wallet

const reader = createChainReader("mainnet");
const [leg] = await resolveTransfer({
  iris, sourceDomain: route.source.domain, txHash: "0x…",
  isNonceUsed: reader.isNonceUsed, destinationBlock: reader.destinationBlock,
});
// leg.phase: not_found | attesting | ready | expired | delivered
```

`delivered` comes only from the destination chain's `usedNonces`; Circle
reporting an attestation as complete means signed, not minted.

## Widget

```tsx
import { Bridge } from "injective-usdc-bridge/react";
import "injective-usdc-bridge/react/styles.css";

// Any wallet library: pass the connected address and its EIP-1193 provider
// (Keplr and Leap users: their `.ethereum` provider).
<Bridge wallet={{ address, provider }} onConnectWallet={openWalletPicker} />

// Bridging from Solana also needs a Solana wallet: its address and a signer
// that takes and returns wire-format bytes (Wallet Standard's shape). It also
// finishes a transfer to Solana Circle did not deliver, and takes back the
// SOL deposit a burn from Solana leaves (from 5 days after it).
<Bridge
  wallet={{ address, provider }}
  solanaWallet={{ address: solAddress, signAndSendTransaction }}
  onConnectSolanaWallet={openSolanaPicker}
/>
```

Hosts without Solana wallet code pass `builtInSolanaWallet` instead and the
widget connects Solana wallets itself. For embedding (`bare`, `defaultAmount`,
`onSent`, `onDelivered`, `app`) see the [package README](packages/bridge/README.md).

It quotes, approves and burns (in one prompt where the wallet batches calls,
EIP-5792), tracks every transfer through the bridge service (`apiUrl`,
default `https://bridge-api.choice.exchange`), and offers a one-click finish
for anything stuck. Deposits start on the chain holding the wallet's USDC
unless `defaultChain` is set; `tabTitle` puts a transfer's progress in the
page title. Restyle it with the `--iub-*` CSS
variables on `.iub`; the defaults follow Choice v2. `TransferStatus` is the
tracking card on its own; `ChainLogo` and `ChainPair` are the chain marks.
The logos are web3icons' (MIT), see
[`THIRD_PARTY_NOTICES.md`](packages/bridge/THIRD_PARTY_NOTICES.md).

## Development

```sh
npm install
npm test            # package and service unit tests
npm run typecheck
cd contracts && forge test
cd apps/site && npx vite build && WALLET=0x… SITE_URL=… npm run smoke   # real-Chrome check of the site

# Live, with real funds (dry run unless --send; keys are read, never printed)
KEY_FILE=… npm run live-withdraw -w packages/bridge -- --amount 1 --to solana --recipient <wallet> [--no-forward]
SOL_KEY_FILE=… npm run live-solana-deposit -w packages/bridge -- --amount 1 --recipient 0x…
SOL_KEY_FILE=… npm run live-solana-claim -w packages/bridge -- --tx 0x<Injective burn>
SOL_KEY_FILE=… npm run live-solana-refund -w packages/bridge -- --sig <Solana burn>

# Solana claim and refund against mainnet, simulated, no funds
npm run verify-solana-claims -w packages/bridge
```

## Releasing the package

`injective-usdc-bridge` on npm is published by CI
([`publish-npm.yml`](.github/workflows/publish-npm.yml)) through npm trusted
publishing, with provenance and no stored token:

1. Bump `version` in `packages/bridge/package.json` in a PR (`npm version 0.1.1 -w packages/bridge --no-git-tag-version`), merge it.
2. Tag the merge commit and push the tag: `git tag -a bridge-v0.1.1 -m "injective-usdc-bridge 0.1.1" && git push origin bridge-v0.1.1`.

The job refuses a tag that does not match the package version.

## License

MIT

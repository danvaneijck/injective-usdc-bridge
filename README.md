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
Monad, Sei, Plasma, Ink, Solana (Solana legs not built yet).

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
```

It quotes, approves and burns, tracks every transfer through the bridge
service (`apiUrl`, default `https://bridge-api.choice.exchange`), and offers a
one-click finish for anything stuck. Restyle it with the `--iub-*` CSS
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
```

## License

MIT

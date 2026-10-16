# injective-usdc-bridge

Native USDC between Injective and other chains over Circle CCTP V2, built to be
embedded in any Injective app.

| Path | What |
| --- | --- |
| [`packages/bridge`](packages/bridge) | npm package `injective-usdc-bridge`: chain registry, fee quotes, burn builders, Circle attestation client, delivery status |
| [`contracts`](contracts) | `BridgeReceiver`: Injective-side relay for deposits that include an INJ gas drop |
| [`DESIGN.md`](DESIGN.md) | Architecture, rules learned from the previous bridge, phases |

Status: early. The core package and contract are tested; the relayer service
and the React widget are next.

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

## Development

```sh
npm install
npm test            # package unit tests
npm run typecheck
cd contracts && forge test
```

## License

MIT

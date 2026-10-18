# injective-usdc-bridge

Native USDC to and from Injective over Circle CCTP V2: chain registry, fee
quotes, burn builders, Circle attestation client, delivery status, and a React
widget. Live at [bridge.choice.exchange](https://bridge.choice.exchange);
source and design notes at
[github.com/danvaneijck/injective-usdc-bridge](https://github.com/danvaneijck/injective-usdc-bridge).

```sh
npm install injective-usdc-bridge viem
```

`viem` is a dependency; React 18 or 19 is a peer for the widget only.

## Widget

```tsx
import { Bridge } from "injective-usdc-bridge/react";
import "injective-usdc-bridge/react/styles.css";

<Bridge
  wallet={{ address, provider }}        // the connected 0x address and its EIP-1193 provider
  onConnectWallet={openWalletPicker}    // the host's own picker; the widget never connects EVM wallets itself
  builtInSolanaWallet                   // the widget finds and connects Solana wallets itself
  app="my-app"                          // label for the service's per-app counts
/>
```

Any wallet library works: the widget needs only an address and an EIP-1193
provider. It switches the wallet between chains itself; a wallet that only
works on Injective (Keplr's or Leap's EVM side) can withdraw, and is told so
plainly if it tries a deposit from another chain.

### Props

| Prop | |
| --- | --- |
| `wallet` | `{ address, provider }`, both `null` while disconnected. Re-render with the new address on an account change. |
| `onConnectWallet` | Opens the host's wallet picker. |
| `solanaWallet`, `onConnectSolanaWallet` | A host-managed Solana wallet: its address and a Wallet Standard style signer (bytes in, bytes or signature out). |
| `builtInSolanaWallet` | For hosts with no Solana code: the widget lists Wallet Standard wallets (Phantom, Solflare, Backpack...) in its own sheet and connects them. Ignored when `solanaWallet` is passed. |
| `defaultDirection` | `"deposit"` (to Injective, the default) or `"withdraw"`. |
| `defaultChain` | The other chain's key (`"base"`, `"solana"`...). Without it a deposit starts where the wallet holds USDC. |
| `defaultAmount` | Decimal USDC text the amount field starts with. Read on mount; change the widget's `key` to start over. |
| `onSent(transfer)` | The user signed a burn: chains, domain and hash, amount and the quoted minimum. |
| `onDelivered(view)` | A transfer sent or seen on its way in this session has landed, once per transfer. Refresh balances here. |
| `bare` | No card of its own (width cap, background, border, shadow), for a host's modal or card. |
| `app` | Lowercase label (`[a-z0-9-]`, 32 at most) sent with the tracking hint. A label only, it moves no money. |
| `network` | `"mainnet"` (default) or `"testnet"`. |
| `apiUrl` | Bridge service, default `https://bridge-api.choice.exchange`. |
| `rpcUrls` | Per chain key, RPCs tried before the registry's, e.g. `{ injective: ["https://..."] }`. |
| `tabTitle` | Put transfers' progress in the page title. Off by default. |

`TransferStatus` is the tracking card on its own (`domain`, `txHash`, plus the
wallet, Solana, `bare`, `onDelivered` and service props above), for a
`/tx/<domain>/<hash>` page.

### Styling

Every rule is scoped under `.iub`; every colour, radius and font is a
`--iub-*` variable, so a host restyles it by setting them on `.iub` or an
ancestor. The defaults are Choice v2's. Toasts are portalled to `body` above
everything; the chain and wallet sheets stay inside the widget.

```css
.my-host .iub {
  --iub-bg: #0b0d0c;
  --iub-accent: #7ee787;
  --iub-on-accent: #04130a;
  --iub-font: inherit;
}
```

### Solana wallets without the widget

`useSolanaWallet()` is the same Wallet Standard discovery as a hook, for a
host that shows Solana wallets in its own menu; its `bridgeWallet` is what
`solanaWallet` takes.

## Core

```ts
import { IrisClient, buildBurn, chainByKey, injective, quoteTransfer } from "injective-usdc-bridge";

const iris = new IrisClient({ network: "mainnet" });
const route = { source: injective("mainnet"), destination: chainByKey("mainnet", "base")! };
const quote = await quoteTransfer({ iris, route, amount: 25_000_000n }); // 25 USDC
const plan = buildBurn({ network: "mainnet", route, quote, recipient: "0x..." });
// send plan.approve (if present) and plan.burn with the user's wallet
```

## License

MIT. Chain logos are web3icons' (MIT), see `THIRD_PARTY_NOTICES.md`.

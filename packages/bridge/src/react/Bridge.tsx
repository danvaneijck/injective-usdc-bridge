import { useState } from "react";
import { type Address, getAddress, isAddress } from "viem";
import { Activity } from "./Activity.js";
import { BridgeForm } from "./BridgeForm.js";
import { useActivity, useEnv } from "./hooks.js";
import { progressOf } from "./progress.js";
import { TransferTracker } from "./TransferStatus.js";
import type { BridgeProps } from "./types.js";

type View = { name: "form" } | { name: "activity" } | { name: "track"; domain: number; txHash: string; from: "form" | "activity" };

/**
 * USDC to and from Injective over Circle CCTP. Drop it into any React app and
 * hand it the app's wallet; see BridgeProps.
 */
export function Bridge(props: BridgeProps) {
  const env = useEnv(props);
  const [view, setView] = useState<View>({ name: "form" });
  const raw = props.wallet.address;
  const address: Address | null = raw && isAddress(raw, { strict: false }) ? getAddress(raw) : null;
  const activity = useActivity(env, address);
  const inFlight = activity.items.filter((it) => !it.view || progressOf(it.view, Date.now()).headline !== "Delivered").length;

  return (
    <div className={`iub ${props.className ?? ""}`}>
      <div className="iub-tabs" role="tablist">
        <button type="button" role="tab" aria-selected={view.name === "form" || (view.name === "track" && view.from === "form")} onClick={() => setView({ name: "form" })}>
          Bridge
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={view.name === "activity" || (view.name === "track" && view.from === "activity")}
          onClick={() => setView({ name: "activity" })}
        >
          Activity
          {inFlight > 0 ? <span className="iub-count">{inFlight}</span> : null}
        </button>
      </div>
      {view.name === "form" ? (
        <BridgeForm
          env={env}
          address={address}
          provider={props.wallet.provider}
          onConnectWallet={props.onConnectWallet}
          onSent={(domain, txHash) => setView({ name: "track", domain, txHash, from: "form" })}
          defaultChain={props.defaultChain}
          defaultDirection={props.defaultDirection}
        />
      ) : view.name === "activity" ? (
        <Activity
          env={env}
          connected={address !== null}
          items={activity.items}
          error={activity.error}
          onOpen={(domain, txHash) => setView({ name: "track", domain, txHash, from: "activity" })}
        />
      ) : (
        <TransferTracker
          env={env}
          domain={view.domain}
          txHash={view.txHash}
          wallet={props.wallet}
          onConnectWallet={props.onConnectWallet}
          onBack={() => setView(view.from === "form" ? { name: "form" } : { name: "activity" })}
        />
      )}
    </div>
  );
}

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
  const tab = view.name === "activity" || (view.name === "track" && view.from === "activity") ? "activity" : "form";

  return (
    <div className={`iub ${props.className ?? ""}`}>
      <div className="iub-tabs" role="tablist" data-active={tab === "form" ? "0" : "1"}>
        <span className="iub-tabs-indicator" aria-hidden />
        <button type="button" role="tab" aria-selected={tab === "form"} onClick={() => setView({ name: "form" })}>
          Bridge
        </button>
        <button type="button" role="tab" aria-selected={tab === "activity"} onClick={() => setView({ name: "activity" })}>
          Activity
          {inFlight > 0 ? <span className="iub-count">{inFlight}</span> : null}
        </button>
      </div>

      {/* The form stays mounted behind the other views, so a look at Activity
          keeps what was typed; un-hiding it replays its entrance animation. */}
      <div className="iub-view" hidden={view.name !== "form"}>
        <BridgeForm
          env={env}
          address={address}
          provider={props.wallet.provider}
          onConnectWallet={props.onConnectWallet}
          onSent={(domain, txHash) => setView({ name: "track", domain, txHash, from: "form" })}
          defaultChain={props.defaultChain}
          defaultDirection={props.defaultDirection}
        />
      </div>

      {view.name === "activity" ? (
        <div className="iub-view" key="activity">
          <Activity
            env={env}
            connected={address !== null}
            items={activity.items}
            loading={activity.loading}
            error={activity.error}
            onOpen={(domain, txHash) => setView({ name: "track", domain, txHash, from: "activity" })}
            onStart={() => setView({ name: "form" })}
            onConnectWallet={props.onConnectWallet}
          />
        </div>
      ) : null}

      {view.name === "track" ? (
        <div className="iub-view" key={`track:${view.domain}:${view.txHash}`}>
          <TransferTracker
            env={env}
            domain={view.domain}
            txHash={view.txHash}
            wallet={props.wallet}
            onConnectWallet={props.onConnectWallet}
            onBack={() => setView(view.from === "form" ? { name: "form" } : { name: "activity" })}
          />
        </div>
      ) : null}
    </div>
  );
}

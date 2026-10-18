import { useEffect, useRef, useState } from "react";
import { type Address, getAddress, isAddress } from "viem";
import { Activity } from "./Activity.js";
import { useTransferAlerts } from "./alerts.js";
import { BridgeForm } from "./BridgeForm.js";
import { useSolanaWiring } from "./BuiltInSolana.js";
import { DeliveryWatch } from "./delivered.js";
import { useActivity, useEnv } from "./hooks.js";
import { progressOf } from "./progress.js";
import type { TransferView } from "./api.js";
import { TransferTracker, rootClass } from "./TransferStatus.js";
import { Toasts } from "./toast.js";
import type { BridgeProps } from "./types.js";

type View =
  | { name: "form" }
  | { name: "activity" }
  | { name: "track"; domain: number; txHash: string; from: "form" | "activity"; known?: TransferView[] | undefined };

/**
 * USDC to and from Injective over Circle CCTP. Drop it into any React app and
 * hand it the app's wallet; see BridgeProps.
 */
export function Bridge(props: BridgeProps) {
  const env = useEnv(props);
  const [view, setView] = useState<View>({ name: "form" });
  const solana = useSolanaWiring(props);
  const raw = props.wallet.address;
  const address: Address | null = raw && isAddress(raw, { strict: false }) ? getAddress(raw) : null;
  const solAddress = solana.solanaWallet?.address ?? null;
  const activity = useActivity(env, [address, solAddress].filter((a): a is string => a !== null));

  // Landings, from Activity's poll and from the tracker's faster one.
  const [watch] = useState(() => new DeliveryWatch());
  const onDelivered = useRef(props.onDelivered);
  onDelivered.current = props.onDelivered;
  const report = (views: TransferView[]) => {
    for (const v of watch.update(views)) onDelivered.current?.(v);
  };
  useEffect(() => {
    report(activity.items.flatMap((it) => (it.view ? [it.view] : [])));
    // report only reads refs and the watch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activity.items]);
  const inFlight = activity.items.filter((it) => !it.view || progressOf(it.view, Date.now()).headline !== "Delivered").length;
  const tab = view.name === "activity" || (view.name === "track" && view.from === "activity") ? "activity" : "form";
  const [lookup, setLookup] = useState<string | null>(null);
  // A send the service has not found within minutes never will (it failed or
  // was dropped); it stops counting as on its way.
  const pending = activity.items.filter((it) => it.pending && Date.now() - it.pending.at < 10 * 60_000).length;
  useTransferAlerts(
    activity.items.flatMap((it) => (it.view ? [it.view] : [])),
    { title: props.tabTitle === true, pending },
  );

  return (
    <div className={rootClass(props)}>
      <Toasts />
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
          solanaWallet={solana.solanaWallet}
          onConnectSolanaWallet={solana.onConnectSolanaWallet}
          onSent={(sent) => {
            watch.markSent(sent.domain, sent.txHash);
            setView({ name: "track", domain: sent.domain, txHash: sent.txHash, from: "form" });
            props.onSent?.(sent);
          }}
          defaultChain={props.defaultChain}
          defaultDirection={props.defaultDirection}
          defaultAmount={props.defaultAmount}
        />
      </div>

      {view.name === "activity" ? (
        <div className="iub-view" key="activity">
          <Activity
            env={env}
            connected={address !== null || solAddress !== null}
            items={activity.items}
            loading={activity.loading}
            error={activity.error}
            onOpen={(domain, txHash, known) => setView({ name: "track", domain, txHash, from: "activity", known })}
            onStart={() => setView({ name: "form" })}
            onConnectWallet={props.onConnectWallet}
            solanaWallet={solana.solanaWallet}
            lookup={lookup}
            onLookup={setLookup}
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
            solanaWallet={solana.solanaWallet}
            onConnectSolanaWallet={solana.onConnectSolanaWallet}
            onViews={report}
            // What Activity already knows about it, so a delivered transfer
            // opens as delivered instead of passing through a placeholder.
            known={
              view.known ??
              activity.items.flatMap((it) =>
                it.view && it.view.source.domain === view.domain && it.view.source.txHash.toLowerCase() === view.txHash.toLowerCase() ? [it.view] : [],
              )
            }
            onBack={() => setView(view.from === "form" ? { name: "form" } : { name: "activity" })}
          />
        </div>
      ) : null}
      {solana.ui}
    </div>
  );
}

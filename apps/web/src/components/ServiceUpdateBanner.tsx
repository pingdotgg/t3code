import { useAtomValue } from "@effect/atom-react";
import type { ServiceUpdateState } from "@t3tools/contracts";
import { LoaderCircleIcon, RefreshCwIcon, TriangleAlertIcon } from "lucide-react";
import { memo, useEffect, useState } from "react";

import { useActiveEnvironmentId } from "../state/entities";
import { serverEnvironment, serviceUpdateStateAtom } from "../state/server";
import { useAtomCommand } from "../state/use-atom-command";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "./ui/alert";
import { Button } from "./ui/button";

export const PROLONGED_SERVICE_UPDATE_MS = 5 * 60_000;

function queuedTurnCopy(count: number): string {
  if (count === 0) return "New turns will wait until the update completes.";
  return `${String(count)} ${count === 1 ? "turn is" : "turns are"} queued.`;
}

export const ServiceUpdateBannerView = memo(function ServiceUpdateBannerView({
  state,
  nowMs,
  cancelling = false,
  onCancel,
}: {
  readonly state: ServiceUpdateState;
  readonly nowMs: number;
  readonly cancelling?: boolean;
  readonly onCancel?: () => void;
}) {
  if (state.status === "idle") {
    return null;
  }

  const prolonged = nowMs - Date.parse(state.startedAt) >= PROLONGED_SERVICE_UPDATE_MS;
  const title =
    state.status === "activating"
      ? `Activating T3 Code ${state.targetVersion}`
      : state.activeTurnCount === 0
        ? `T3 Code is updating to ${state.targetVersion}`
        : `T3 Code is updating to ${state.targetVersion} after ${String(state.activeTurnCount)} ${
            state.activeTurnCount === 1 ? "active turn finishes" : "active turns finish"
          }`;
  const description =
    state.status === "activating"
      ? `The service will restart and reconnect shortly. ${queuedTurnCopy(state.queuedTurnCount)}`
      : prolonged
        ? `${queuedTurnCopy(state.queuedTurnCount)} This drain is taking longer than expected; cancel the update to run queued turns now.`
        : queuedTurnCopy(state.queuedTurnCount);

  return (
    <div
      className="pointer-events-none fixed top-2 left-1/2 z-[80] w-[min(46rem,calc(100%-1rem))] -translate-x-1/2"
      data-service-update-status={state.status}
    >
      <Alert
        variant={prolonged && state.status === "draining" ? "warning" : "info"}
        className="pointer-events-auto bg-background/96 shadow-lg backdrop-blur-md"
      >
        {prolonged && state.status === "draining" ? (
          <TriangleAlertIcon aria-hidden />
        ) : state.status === "activating" ? (
          <LoaderCircleIcon className="animate-spin" aria-hidden />
        ) : (
          <RefreshCwIcon aria-hidden />
        )}
        <AlertTitle>{title}</AlertTitle>
        <AlertDescription>{description}</AlertDescription>
        {prolonged && state.status === "draining" && onCancel ? (
          <AlertAction>
            <Button size="xs" variant="outline" disabled={cancelling} onClick={onCancel}>
              {cancelling ? "Cancelling…" : "Cancel update"}
            </Button>
          </AlertAction>
        ) : null}
      </Alert>
    </div>
  );
});

export function ServiceUpdateBanner() {
  const environmentId = useActiveEnvironmentId();
  const state = useAtomValue(serviceUpdateStateAtom(environmentId));
  const cancelServiceUpdate = useAtomCommand(serverEnvironment.cancelServiceUpdate, {
    label: "cancel service update",
  });
  const [nowMs, setNowMs] = useState(Date.now);
  const [cancelling, setCancelling] = useState(false);

  useEffect(() => {
    if (state.status === "idle") {
      return;
    }
    setNowMs(Date.now());
    const interval = window.setInterval(() => setNowMs(Date.now()), 30_000);
    return () => window.clearInterval(interval);
  }, [state.status]);

  if (environmentId === null) {
    return null;
  }

  return (
    <ServiceUpdateBannerView
      state={state}
      nowMs={nowMs}
      cancelling={cancelling}
      onCancel={() => {
        setCancelling(true);
        void cancelServiceUpdate({ environmentId, input: {} }).finally(() => {
          setCancelling(false);
        });
      }}
    />
  );
}

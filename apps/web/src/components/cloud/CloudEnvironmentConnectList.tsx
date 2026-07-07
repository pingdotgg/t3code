import { findErrorTraceId } from "@t3tools/client-runtime/errors";
import {
  RelayConnectionRegistration,
  RelayConnectionTarget,
} from "@t3tools/client-runtime/connection";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId } from "@t3tools/contracts";
import type { RelayClientEnvironmentRecord } from "@t3tools/contracts/relay";
import * as Option from "effect/Option";
import { type ReactNode, useCallback, useEffect, useMemo, useState } from "react";

import { environmentCatalog } from "~/connection/catalog";
import { cn } from "~/lib/utils";
import { relayEnvironmentDiscovery } from "~/state/relay";
import { useRelayEnvironmentDiscovery } from "~/state/environments";
import { useAtomCommand } from "~/state/use-atom-command";
import { ConnectionStatusDot } from "../ConnectionStatusDot";
import { ITEM_ROW_CLASSNAME, ITEM_ROW_INNER_CLASSNAME } from "../settings/itemRows";
import { Button } from "../ui/button";
import { Skeleton } from "../ui/skeleton";
import { toastManager } from "../ui/toast";

export function RemoteEnvironmentRowsSkeleton() {
  return (
    <div className={ITEM_ROW_CLASSNAME}>
      <div className={ITEM_ROW_INNER_CLASSNAME}>
        <div className="min-w-0 flex-1 space-y-2">
          <Skeleton className="h-4 w-32 rounded-full" />
          <Skeleton className="h-3 w-20 rounded-full" />
        </div>
        <Skeleton className="h-7 w-16 rounded-md" />
      </div>
    </div>
  );
}

/**
 * The user's T3 Connect environments from relay discovery, each with a
 * Connect button. The primary environment is always excluded; already-saved
 * environments are hidden unless `showSavedAsConnected` renders them as
 * connected instead (used by onboarding, where the full device mesh should be
 * visible).
 */
export function CloudEnvironmentConnectRows({
  primaryEnvironmentId,
  savedEnvironmentIds,
  showSavedAsConnected = false,
  empty = null,
}: {
  readonly primaryEnvironmentId: EnvironmentId | null;
  readonly savedEnvironmentIds: ReadonlyArray<EnvironmentId>;
  readonly showSavedAsConnected?: boolean;
  readonly empty?: ReactNode;
}) {
  const environmentsState = useRelayEnvironmentDiscovery();
  const registerEnvironment = useAtomCommand(environmentCatalog.register, {
    reportFailure: false,
  });
  const refreshRelayEnvironments = useAtomCommand(relayEnvironmentDiscovery.refresh, {
    reportFailure: false,
  });
  const connectRelayEnvironment = useCallback(
    (environment: RelayClientEnvironmentRecord) =>
      registerEnvironment(
        new RelayConnectionRegistration({
          target: new RelayConnectionTarget({
            environmentId: environment.environmentId,
            label: environment.label,
          }),
        }),
      ),
    [registerEnvironment],
  );
  const [connectingEnvironmentId, setConnectingEnvironmentId] = useState<EnvironmentId | null>(
    null,
  );
  const savedIds = useMemo(() => new Set(savedEnvironmentIds), [savedEnvironmentIds]);

  useEffect(() => {
    void refreshRelayEnvironments();
  }, [refreshRelayEnvironments]);

  const connectEnvironment = async (environment: RelayClientEnvironmentRecord) => {
    setConnectingEnvironmentId(environment.environmentId);
    const result = await connectRelayEnvironment(environment);
    setConnectingEnvironmentId(null);
    if (result._tag === "Success") {
      toastManager.add({
        type: "success",
        title: "Environment connected",
        description: `${environment.label} is available through T3 Connect.`,
      });
      return;
    }
    if (isAtomCommandInterrupted(result)) {
      return;
    }
    const cause = squashAtomCommandFailure(result);
    const message =
      cause instanceof Error ? cause.message : "Could not connect the T3 Connect environment.";
    const traceId = findErrorTraceId(cause);
    console.error("[t3-connect] Could not connect environment", { message, traceId, cause });
    toastManager.add({
      type: "error",
      title: "Could not connect environment",
      description: message,
      data: traceId
        ? {
            secondaryActionProps: {
              children: "Copy trace ID",
              onClick: () => void navigator.clipboard?.writeText(traceId),
            },
          }
        : undefined,
    });
  };

  const visibleEnvironments = [...environmentsState.environments.values()].filter(
    ({ environment }) =>
      environment.environmentId !== primaryEnvironmentId &&
      (showSavedAsConnected || !savedIds.has(environment.environmentId)),
  );

  const standalone = showSavedAsConnected || savedEnvironmentIds.length === 0;

  if (
    standalone &&
    visibleEnvironments.length === 0 &&
    environmentsState.refreshing &&
    environmentsState.environments.size === 0
  ) {
    return <RemoteEnvironmentRowsSkeleton />;
  }

  if (standalone && visibleEnvironments.length === 0) {
    // A failed or offline discovery is not "no environments" — misreporting it
    // as empty would read as the user's devices having disappeared.
    const discoveryProblem = environmentsState.offline
      ? "You appear to be offline."
      : (Option.getOrNull(environmentsState.error)?.message ?? null);
    if (discoveryProblem !== null && !environmentsState.refreshing) {
      return (
        <div className={ITEM_ROW_CLASSNAME}>
          <p className="text-sm font-medium text-destructive">
            Could not load T3 Connect environments
          </p>
          <p className="mt-1 text-xs text-muted-foreground">{discoveryProblem}</p>
          <Button
            size="sm"
            variant="outline"
            className="mt-3"
            onClick={() => void refreshRelayEnvironments()}
          >
            Try again
          </Button>
        </div>
      );
    }
    return empty;
  }

  return visibleEnvironments.map(({ environment, availability, error }) => {
    const alreadyConnected = savedIds.has(environment.environmentId);
    return (
      <div key={environment.environmentId} className={ITEM_ROW_CLASSNAME}>
        <div className={ITEM_ROW_INNER_CLASSNAME}>
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <ConnectionStatusDot
                dotClassName={
                  availability === "online"
                    ? "bg-success"
                    : availability === "error"
                      ? "bg-destructive"
                      : availability === "checking"
                        ? "bg-warning"
                        : "bg-muted-foreground/35"
                }
                pingClassName={availability === "checking" ? "bg-warning/60 duration-2000" : null}
                tooltipText={
                  availability === "online"
                    ? "Relay online"
                    : availability === "offline"
                      ? "Relay offline"
                      : availability === "checking"
                        ? "Checking relay status"
                        : (Option.getOrNull(error)?.message ?? "Relay status unavailable")
                }
              />
              <p className="truncate text-sm font-medium">{environment.label}</p>
            </div>
            <p
              className={cn(
                "mt-1 truncate text-xs",
                availability === "error" ? "text-destructive" : "text-muted-foreground",
              )}
            >
              {availability === "online"
                ? "Available · Relay online"
                : availability === "offline"
                  ? "Available · Relay offline"
                  : availability === "checking"
                    ? "Available · Checking relay status…"
                    : (Option.getOrNull(error)?.message ?? "Available · Relay status unavailable")}
            </p>
          </div>
          {alreadyConnected ? (
            <Button size="sm" variant="outline" disabled>
              Connected
            </Button>
          ) : (
            <Button
              size="sm"
              disabled={connectingEnvironmentId !== null}
              onClick={() => void connectEnvironment(environment)}
            >
              {connectingEnvironmentId === environment.environmentId ? "Connecting…" : "Connect"}
            </Button>
          )}
        </div>
      </div>
    );
  });
}

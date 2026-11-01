import { findErrorTraceId } from "@t3tools/client-runtime/errors";
import {
  type ConnectionCatalogEntry,
  type EnvironmentConnectionPresentation,
  RelayConnectionRegistration,
  RelayConnectionTarget,
  orchestrationProtocolCompatibilityError,
} from "@t3tools/client-runtime/connection";
import { relayOfflineReasonMessage } from "@t3tools/client-runtime/relay";
import {
  isAtomCommandInterrupted,
  settlePromise,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  type EnvironmentId,
  resolveEnvironmentMachineKind,
  type ServerConfig,
} from "@t3tools/contracts";
import type {
  RelayClientEnvironmentRecord,
  RelayEnvironmentStatusResponse,
} from "@t3tools/contracts/relay";
import { useAtomValue } from "@effect/atom-react";
import * as Option from "effect/Option";
import { type ReactNode, useEffect, useEffectEvent, useState } from "react";

import { APP_VERSION } from "~/branding";
import { environmentCatalog } from "~/connection/catalog";
import { cn } from "~/lib/utils";
import { relayEnvironmentDiscovery } from "~/state/relay";
import { serverEnvironment } from "~/state/server";
import { useRelayEnvironmentDiscovery } from "~/state/environments";
import { useAtomCommand } from "~/state/use-atom-command";
import { ConnectionStatusDot } from "../ConnectionStatusDot";
import { OutdatedServerUpdateAction, serverUpdateStageLabel } from "../ServerUpdateAction";
import { EnvironmentMachineIcon } from "../EnvironmentMachineIcon";
import { ITEM_ROW_CLASSNAME, ITEM_ROW_INNER_CLASSNAME } from "../settings/itemRows";
import { Checkbox } from "../ui/checkbox";
import { Button } from "../ui/button";
import { Skeleton } from "../ui/skeleton";
import { toastManager } from "../ui/toast";
import { Tooltip, TooltipTrigger, TooltipPopup } from "../ui/tooltip";
import { presentSavedCloudEnvironmentConnection } from "./cloudEnvironmentConnectionPresentation";

const EMPTY_DISCOVERY_REFRESH_INTERVAL_MS = 5_000;

function cloudEnvironmentCompatibility(
  status: Option.Option<RelayEnvironmentStatusResponse> | undefined,
  saved?: SavedCloudEnvironmentConnection,
) {
  const descriptor = status === undefined ? undefined : Option.getOrNull(status)?.descriptor;
  // The runtime owns a saved server's compatibility. It knows which route a
  // rejection came from and keeps a newer socket rejection over replayed discovery.
  if (saved !== undefined) {
    const updatable = saved.entry?.serverUpdateRequired === true;
    const unsupported = updatable || saved.connection.phase === "unsupported";
    return {
      descriptor,
      unsupported,
      updatable,
      blocked: unsupported && !updatable,
      detail: unsupported ? saved.connection.error : null,
    };
  }
  const error =
    descriptor === undefined ? null : orchestrationProtocolCompatibilityError(descriptor);
  const updatable = error?.serverUpdateRequired === true;
  return {
    descriptor,
    unsupported: error !== null,
    updatable,
    blocked: error !== null && !updatable,
    detail: error?.message ?? null,
  };
}

function OutdatedServerRowUpdate(props: {
  readonly environmentId: EnvironmentId;
  readonly serverLabel: string;
  readonly fromVersion: string | undefined;
}) {
  const state = useAtomValue(serverEnvironment.updateStateAtom(props.environmentId));
  if (state.status === "running") {
    return (
      <span className="shrink-0 text-xs text-muted-foreground">
        {serverUpdateStageLabel(state.stage)}
      </span>
    );
  }
  return (
    <OutdatedServerUpdateAction
      {...props}
      targetVersion={APP_VERSION}
      label={state.status === "failed" ? "Retry update" : "Update"}
    />
  );
}

export interface SavedCloudEnvironmentConnection {
  readonly environmentId: EnvironmentId;
  readonly connection: EnvironmentConnectionPresentation;
  readonly relayManaged: boolean;
  readonly serverConfig?: Pick<ServerConfig, "environment"> | null;
  readonly entry?: Partial<Pick<ConnectionCatalogEntry, "serverUpdateRequired" | "enabled">>;
}

function RemoteEnvironmentRowsSkeleton() {
  return (
    <div className={ITEM_ROW_CLASSNAME}>
      <div className={ITEM_ROW_INNER_CLASSNAME}>
        <div className="min-w-0 flex-1 space-y-2">
          <Skeleton shape="pill" className="h-4 w-32" />
          <Skeleton shape="pill" className="h-3 w-20" />
        </div>
        <Skeleton className="h-7 w-16" />
      </div>
    </div>
  );
}

export function CloudEnvironmentConnectRows({
  primaryEnvironmentId,
  savedEnvironments,
  showSavedEnvironments = false,
  refreshWhileEmpty = false,
  empty = null,
  selection,
  onDiscoveryReady,
}: {
  readonly primaryEnvironmentId: EnvironmentId | null;
  readonly savedEnvironments: ReadonlyArray<SavedCloudEnvironmentConnection>;
  readonly showSavedEnvironments?: boolean;
  readonly refreshWhileEmpty?: boolean;
  readonly empty?: ReactNode;
  readonly onDiscoveryReady?: () => void;
  readonly selection?: {
    readonly autoSelectedComputers?: Set<EnvironmentId>;
    readonly selectedIds: ReadonlySet<EnvironmentId>;
    readonly onChange: (environmentId: EnvironmentId, selected: boolean) => void;
  };
}) {
  const environmentsState = useRelayEnvironmentDiscovery();
  const registerEnvironment = useAtomCommand(environmentCatalog.register, {
    reportFailure: false,
  });
  const setEnvironmentEnabled = useAtomCommand(environmentCatalog.setEnabled);
  const refreshRelayEnvironments = useAtomCommand(relayEnvironmentDiscovery.refresh, {
    reportFailure: false,
  });
  const refreshDiscoveryWhenIdle = useEffectEvent(async () => {
    if (environmentsState.refreshing || environmentsState.offline) return;
    await refreshRelayEnvironments();
  });
  const connectRelayEnvironment = (environment: RelayClientEnvironmentRecord) =>
    registerEnvironment(
      new RelayConnectionRegistration({
        target: new RelayConnectionTarget({
          environmentId: environment.environmentId,
          label: environment.label,
        }),
      }),
    );
  const [connectingEnvironmentIds, setConnectingEnvironmentIds] = useState<
    ReadonlySet<EnvironmentId>
  >(new Set());
  const savedById = new Map(
    savedEnvironments
      .filter((environment) => environment.relayManaged)
      .map((environment) => [environment.environmentId, environment]),
  );
  const savedWithoutRelay = new Set(
    savedEnvironments
      .filter((environment) => !environment.relayManaged)
      .map((environment) => environment.environmentId),
  );

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- fetches relay discovery when its inputs change, unless hidden polling covers it, and reports readiness
  useEffect(() => {
    let active = true;
    if (onDiscoveryReady || !refreshWhileEmpty || document.visibilityState === "visible") {
      void refreshRelayEnvironments().then(() => {
        if (active) onDiscoveryReady?.();
      });
    }
    return () => {
      active = false;
    };
  }, [refreshRelayEnvironments, refreshWhileEmpty, onDiscoveryReady]);

  const connectEnvironment = async (environment: RelayClientEnvironmentRecord) => {
    const { blocked } = cloudEnvironmentCompatibility(
      environmentsState.environments.get(environment.environmentId)?.status,
      savedById.get(environment.environmentId),
    );
    if (blocked) return false;
    setConnectingEnvironmentIds((current) => new Set([...current, environment.environmentId]));
    const result = await connectRelayEnvironment(environment);
    setConnectingEnvironmentIds((current) => {
      const next = new Set(current);
      next.delete(environment.environmentId);
      return next;
    });
    if (result._tag === "Success") {
      toastManager.add({
        type: "success",
        title: savedWithoutRelay.has(environment.environmentId)
          ? "T3 Connect route added"
          : "Environment added",
        description: savedWithoutRelay.has(environment.environmentId)
          ? `${environment.label} falls back to T3 Connect when its other routes are unreachable.`
          : `Connecting to ${environment.label} through T3 Connect.`,
      });
      return true;
    }
    if (isAtomCommandInterrupted(result)) {
      return false;
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
    return false;
  };

  // Omit machines saved over other routes; onboarding selection must not add a T3 Connect route.
  const isVisibleEnvironment = (environmentId: EnvironmentId) =>
    environmentId !== primaryEnvironmentId &&
    (showSavedEnvironments || !savedById.has(environmentId)) &&
    !(selection && savedWithoutRelay.has(environmentId));
  const visibleEnvironments = [...environmentsState.environments.values()].filter(
    ({ environment }) => isVisibleEnvironment(environment.environmentId),
  );
  const selectNewComputers = useEffectEvent(
    (environments: typeof environmentsState.environments) => {
      const seen = selection?.autoSelectedComputers;
      if (!selection || !seen) return;
      for (const { environment, status, availability } of environments.values()) {
        if (!isVisibleEnvironment(environment.environmentId)) continue;
        const id = environment.environmentId;
        if (availability === "checking") continue;
        const { unsupported, blocked } = cloudEnvironmentCompatibility(status, savedById.get(id));
        if (unsupported) {
          seen.add(id);
          if (blocked && selection.selectedIds.has(id)) selection.onChange(id, false);
          continue;
        }
        if (seen.has(id)) continue;
        seen.add(id);
        selection.onChange(id, true);
        if (!savedById.has(id)) {
          void connectEnvironment(environment).then((connected) => {
            if (!connected) selection.onChange(id, false);
          });
        }
      }
    },
  );
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- auto-selects newly discovered machines from the discovery store and starts their relay connections
  useEffect(() => {
    // oxlint-disable-next-line react/set-state-in-effect -- Discovery results arrive from an external store and auto-selection starts relay connections, which mark themselves connecting.
    selectNewComputers(environmentsState.environments);
  }, [environmentsState.environments]);

  // Discovery clears its list on refresh, so poll only until a machine appears.
  const shouldRefreshWhileEmpty =
    refreshWhileEmpty && visibleEnvironments.length === 0 && !environmentsState.offline;

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- polls relay discovery on a timer, focus and visibility change while no machine is found
  useEffect(() => {
    if (!shouldRefreshWhileEmpty) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let disposed = false;
    let pending = false;
    const visible = () => document.visibilityState === "visible";
    const schedule = () => {
      clearTimeout(timer);
      if (!disposed && visible()) {
        timer = setTimeout(() => void refresh(), EMPTY_DISCOVERY_REFRESH_INTERVAL_MS);
      }
    };
    const refresh = async () => {
      if (disposed || pending || !visible()) return;
      clearTimeout(timer);
      pending = true;
      await settlePromise(() => refreshDiscoveryWhenIdle());
      pending = false;
      schedule();
    };
    const onFocus = () => void refresh();
    const onVisibilityChange = () => {
      clearTimeout(timer);
      if (visible()) void refresh();
    };

    schedule();
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      disposed = true;
      clearTimeout(timer);
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [shouldRefreshWhileEmpty]);

  const standalone = showSavedEnvironments || savedEnvironments.length === 0;

  if (
    !refreshWhileEmpty &&
    standalone &&
    visibleEnvironments.length === 0 &&
    environmentsState.refreshing &&
    environmentsState.environments.size === 0
  ) {
    return <RemoteEnvironmentRowsSkeleton />;
  }

  if (standalone && visibleEnvironments.length === 0) {
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

  return visibleEnvironments.map(({ environment, availability, error, status }) => {
    const savedEnvironment = savedById.get(environment.environmentId);
    const {
      descriptor,
      unsupported,
      detail: unsupportedDetail,
      updatable,
      blocked,
    } = cloudEnvironmentCompatibility(status, savedEnvironment);
    const savedConnection = unsupported
      ? presentSavedCloudEnvironmentConnection({
          phase: "unsupported",
          error: unsupportedDetail,
          traceId: null,
        })
      : savedEnvironment
        ? presentSavedCloudEnvironmentConnection(savedEnvironment.connection)
        : null;
    const relayStatus = status === undefined ? null : Option.getOrNull(status);
    const updateAction =
      updatable && savedEnvironment ? (
        <OutdatedServerRowUpdate
          environmentId={environment.environmentId}
          serverLabel={`${environment.label} server`}
          fromVersion={descriptor?.serverVersion}
        />
      ) : null;
    const offlineReason =
      availability === "offline" && relayStatus !== null
        ? relayOfflineReasonMessage(relayStatus)
        : null;
    const machineKind = resolveEnvironmentMachineKind(
      savedEnvironment?.serverConfig ??
        (descriptor === undefined ? null : { environment: descriptor }),
    );
    const dotClassName = savedConnection
      ? savedConnection.tone === "connected"
        ? "bg-success"
        : savedConnection.tone === "connecting"
          ? "bg-warning"
          : savedConnection.tone === "error"
            ? "bg-destructive"
            : "bg-muted-foreground/35"
      : availability === "online"
        ? "bg-success"
        : availability === "error"
          ? "bg-destructive"
          : availability === "checking"
            ? "bg-warning"
            : "bg-muted-foreground/35";
    const notAdded = savedWithoutRelay.has(environment.environmentId)
      ? "Saved without T3 Connect"
      : "Not added";
    const statusText =
      unsupported && !savedEnvironment
        ? `T3 Connect · ${notAdded} · ${updatable ? "Server update required" : "Client not supported"}`
        : offlineReason !== null
          ? offlineReason
          : savedConnection
            ? savedConnection.statusText
            : availability === "online"
              ? `T3 Connect · ${notAdded} · Relay online`
              : availability === "offline"
                ? `T3 Connect · ${notAdded} · Relay offline`
                : availability === "checking"
                  ? `T3 Connect · ${notAdded} · Checking relay status…`
                  : (Option.getOrNull(error)?.message ??
                    `T3 Connect · ${notAdded} · Relay status unavailable`);
    if (selection) {
      return (
        <label
          key={environment.environmentId}
          className="flex cursor-pointer items-center gap-3 rounded-lg border border-border bg-background px-3 py-2.5 has-disabled:cursor-default"
        >
          <Checkbox
            checked={!blocked && selection.selectedIds.has(environment.environmentId)}
            disabled={blocked || connectingEnvironmentIds.has(environment.environmentId)}
            onCheckedChange={async (checked) => {
              if (blocked) return;
              selection.onChange(environment.environmentId, checked);
              if (checked && !savedEnvironment) {
                const connected = await connectEnvironment(environment);
                if (!connected) selection.onChange(environment.environmentId, false);
              } else if (checked && !unsupported && savedEnvironment?.entry?.enabled === false) {
                const result = await setEnvironmentEnabled({
                  environmentId: environment.environmentId,
                  enabled: true,
                });
                if (result._tag !== "Success") selection.onChange(environment.environmentId, false);
              }
            }}
          />
          <EnvironmentMachineIcon
            aria-hidden
            kind={machineKind}
            className="size-4 shrink-0 text-muted-foreground"
          />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm font-medium">{environment.label}</span>
            {unsupportedDetail !== null ? (
              <span className="mt-0.5 block text-xs text-muted-foreground">
                {unsupportedDetail}
              </span>
            ) : null}
          </span>
          {updateAction ?? (
            <Tooltip>
              <TooltipTrigger
                render={<span tabIndex={0} />}
                className={cn(
                  "max-w-[45%] shrink-0 truncate text-xs",
                  savedConnection?.tone === "error" ? "text-destructive" : "text-muted-foreground",
                )}
              >
                {connectingEnvironmentIds.has(environment.environmentId)
                  ? "Connecting…"
                  : updatable && !savedEnvironment
                    ? "Server update required"
                    : (savedConnection?.buttonLabel ??
                      (availability === "online"
                        ? "Available"
                        : availability === "offline"
                          ? "Offline"
                          : availability === "error"
                            ? "Unavailable"
                            : "Checking…"))}
              </TooltipTrigger>
              <TooltipPopup>{unsupportedDetail ?? statusText}</TooltipPopup>
            </Tooltip>
          )}
        </label>
      );
    }
    return (
      <div key={environment.environmentId} className={ITEM_ROW_CLASSNAME}>
        <div className={ITEM_ROW_INNER_CLASSNAME}>
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <ConnectionStatusDot
                dotClassName={dotClassName}
                pingClassName={
                  savedConnection?.tone === "connecting" ||
                  (savedConnection === null && availability === "checking")
                    ? "bg-warning/60 duration-2000"
                    : null
                }
                tooltipText={
                  unsupportedDetail !== null
                    ? unsupportedDetail
                    : offlineReason !== null
                      ? offlineReason
                      : savedConnection
                        ? savedConnection.statusText
                        : availability === "online"
                          ? "Relay online"
                          : availability === "offline"
                            ? "Relay offline"
                            : availability === "checking"
                              ? "Checking relay status"
                              : (Option.getOrNull(error)?.message ?? "Relay status unavailable")
                }
              />
              <EnvironmentMachineIcon
                aria-hidden
                kind={machineKind}
                className="size-4 shrink-0 text-muted-foreground"
              />
              <p className="truncate text-sm font-medium">{environment.label}</p>
            </div>
            <p
              className={cn(
                "mt-1 truncate text-xs",
                savedConnection?.tone === "error" ||
                  (savedConnection?.tone === "connecting" && savedEnvironment?.connection.error) ||
                  (savedConnection === null && availability === "error")
                  ? "text-destructive"
                  : "text-muted-foreground",
              )}
            >
              {statusText}
            </p>
          </div>
          {updateAction ??
            (savedEnvironment && savedConnection ? (
              <Button size="sm" variant="outline" disabled>
                {savedConnection.buttonLabel}
              </Button>
            ) : blocked ? (
              <Tooltip>
                <TooltipTrigger render={<span className="inline-flex" tabIndex={0} />}>
                  <Button size="sm" disabled>
                    Add
                  </Button>
                </TooltipTrigger>
                <TooltipPopup>{unsupportedDetail ?? "Client not supported"}</TooltipPopup>
              </Tooltip>
            ) : (
              <Button
                size="sm"
                disabled={connectingEnvironmentIds.size > 0}
                onClick={() => void connectEnvironment(environment)}
              >
                {connectingEnvironmentIds.has(environment.environmentId)
                  ? "Adding…"
                  : savedWithoutRelay.has(environment.environmentId)
                    ? "Add route"
                    : "Add"}
              </Button>
            ))}
        </div>
      </div>
    );
  });
}

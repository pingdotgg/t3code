import { msg, T, useGT, useMessages } from "gt-react";
import { m, type MessageResolver } from "../../i18n/messages";

import { SessionPermissions } from "./SessionPermissions";
import { ChevronRightIcon, ChevronsLeftRightEllipsisIcon, RouteIcon } from "lucide-react";
import { useAtomValue } from "@effect/atom-react";
import { type ReactNode, useState } from "react";
import { type EnvironmentId, resolveEnvironmentMachineKind } from "@t3tools/contracts";
import {
  connectionRoutes,
  hasSavedBearerRoute,
  connectionErrorText,
  connectionStatusText,
  environmentMcpUrl,
  lastSeenLabel,
} from "@t3tools/client-runtime/connection";

import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import { cn } from "../../lib/utils";
import { EnvironmentActionsMenu } from "./EnvironmentActionsMenu";
import { EnvironmentRoutesList } from "./EnvironmentRoutesList";
import {
  ConnectionDiagnosisPanel,
  ConnectionDiagnosisSummary,
  useConnectionDiagnosis,
} from "./ConnectionDiagnosisDetails";
import { usePreparedConnection } from "~/state/session";
import { EnvironmentRow, environmentTransportLabel } from "./EnvironmentRow";
import { MenuItem, MenuSeparator } from "../ui/menu";
import { Switch } from "../ui/switch";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "../ui/empty";
import {
  resolveServerConfigVersionMismatch,
  resolveServerSelfUpdateCapability,
  supportsDesktopAppUpdate,
} from "~/versionSkew";
import { environmentCatalog } from "~/connection/catalog";
import type { EnvironmentPresentation } from "~/state/environments";
import { APP_VERSION } from "~/branding";
import { useAtomCommand } from "../../state/use-atom-command";
import { serverEnvironment } from "~/state/server";
import {
  OutdatedServerUpdateAction,
  ServerUpdateAction,
  ServerUpdateProgress,
} from "../ServerUpdateAction";

/** What the network adds to a saved machine's row (`useMachineParts`, `useHostParts`). */
export interface SavedMachineNetwork {
  /** In the network: switched off rather than removed, since the network would open it again. */
  readonly member: boolean;
  /** What the network is doing to open it again after its session was refused, if anything. */
  readonly activity: string | null;
  readonly details: ReadonlyArray<string | null>;
  readonly actions: ReactNode;
  readonly menuItems: ReactNode;
  readonly dialogs: ReactNode;
}

type SavedBackendListRowProps = {
  environment: EnvironmentPresentation;
  network?: SavedMachineNetwork | null;
  removingEnvironmentId: EnvironmentId | null;
  onSetEnabled: (environmentId: EnvironmentId, enabled: boolean) => void;
  onRemove: (environment: EnvironmentPresentation) => void;
  onAddRoute: (environment: EnvironmentPresentation) => void;
};

function savedBackendStatus(
  environment: EnvironmentPresentation,
  resolve: MessageResolver = m,
): {
  readonly text: string;
  readonly tone: "muted" | "error";
} {
  if (!environment.entry.enabled && environment.connection.phase !== "unsupported")
    return { text: "Off in this app", tone: "muted" };
  const { connection } = environment;
  const error = connectionErrorText(connection, resolve);
  switch (connection.phase) {
    case "connected":
      return { text: resolve(msg("Connected")), tone: "muted" };
    case "connecting":
      return { text: "Connecting…", tone: "muted" };
    case "reconnecting":
      return {
        text: error
          ? resolve(msg("Reconnecting: {error}", { error }))
          : resolve(msg("Reconnecting")),
        tone: "error",
      };
    case "unsupported":
      return { text: resolve(msg("Client not supported")), tone: "muted" };
    case "error":
      if (connection.needsPairing === true) return { text: "Needs pairing again", tone: "error" };
      return {
        text: error
          ? resolve(msg("Connection failed: {error}", { error }))
          : resolve(msg("Connection failed")),
        tone: "error",
      };
    case "offline":
      return {
        text:
          connection.lastConnectedAt === undefined
            ? "Offline"
            : `Offline · ${lastSeenLabel(connection.lastConnectedAt, Date.now())}`,
        tone: "muted",
      };
    case "available":
      return { text: resolve(msg("Not connected")), tone: "muted" };
  }
}

export function SavedBackendListRow({
  environment,
  network = null,
  removingEnvironmentId,
  onSetEnabled,
  onRemove,
  onAddRoute,
}: SavedBackendListRowProps) {
  const messages = useMessages();
  const gt = useGT();
  const [routesOpen, setRoutesOpen] = useState(false);
  const [permissionsOpen, setPermissionsOpen] = useState(false);
  const [diagnosisOpen, setDiagnosisOpen] = useState(false);
  const environmentId = environment.environmentId;
  const unsupported = environment.connection.phase === "unsupported";
  const blocked = unsupported && !hasSavedBearerRoute(environment.entry);
  const enabled = environment.entry.enabled && !unsupported;
  const isConnected = environment.connection.phase === "connected";
  const isRemoving = removingEnvironmentId === environmentId;
  const errorTraceId = environment.connection.traceId;
  const { copyToClipboard: copyTraceIdToClipboard } = useCopyToClipboard<{ traceId: string }>({
    target: {
      target: "trace ID",
      unavailableMessage: msg("Clipboard API is unavailable while copying trace ID."),
      failureMessage: msg("Failed to copy trace ID to the clipboard."),
    },
    onError: (error) => {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: gt("Could not copy trace ID"),
          description: error.message,
        }),
      );
    },
  });
  const copyTraceId = (traceId: string) => {
    copyTraceIdToClipboard(traceId, { traceId });
  };
  const { copyToClipboard: copyMcpUrl } = useCopyToClipboard<{ url: string }>({
    target: {
      target: "MCP URL",
      unavailableMessage: msg("Clipboard API is unavailable while copying MCP URL."),
      failureMessage: msg("Failed to copy MCP URL to the clipboard."),
    },
    onCopy: ({ url }) => {
      toastManager.add({
        type: "success",
        title: gt("MCP URL copied"),
        description: gt("Add it to an agent, e.g. claude mcp add --transport http t3 {url}", {
          url,
        }),
      });
    },
    onError: (error) => {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: gt("Could not copy MCP URL"),
          description: error.message,
        }),
      );
    },
  });
  const versionMismatch = resolveServerConfigVersionMismatch(environment.serverConfig, messages);
  const serverUpdateState = useAtomValue(serverEnvironment.updateStateAtom(environmentId));
  const resumingServerUpdate =
    serverUpdateState.status === "running" && serverUpdateState.stage === "resuming";
  // The network re-opens a refused member, so its progress replaces "Needs pairing again".
  const activity = enabled ? (network?.activity ?? null) : null;
  const status =
    activity === null
      ? savedBackendStatus(environment)
      : { text: activity, tone: "muted" as const };
  const serverVersion = environment.serverConfig?.environment.serverVersion ?? null;
  const retryNow = useAtomCommand(environmentCatalog.retryNow);
  const { diagnosis: currentDiagnosis, state: connectionState } =
    useConnectionDiagnosis(environment);
  const diagnosis = resumingServerUpdate || activity !== null ? null : currentDiagnosis;
  const prepared = usePreparedConnection(environmentId);
  const connectedTarget = isConnected && prepared._tag === "Some" ? prepared.value.target : null;
  const mcpUrl = environmentMcpUrl({
    entry: environment.entry,
    connectedTarget,
  });
  const machineKind = resolveEnvironmentMachineKind(environment.serverConfig);
  const routeCount = connectionRoutes(environment.entry).length;
  const networkDetails = (network?.details ?? []).filter(
    (detail): detail is string => detail !== null,
  );
  const subtitleText = [
    // The headline below names the failure in full.
    diagnosis ? null : resumingServerUpdate ? "Restarting" : status.text,
    environmentTransportLabel(environment, connectedTarget),
    enabled && versionMismatch ? serverVersion : null,
  ]
    .filter((value): value is string => value !== null)
    .join(" · ");

  const showUpdateAction =
    enabled &&
    isConnected &&
    versionMismatch !== null &&
    (serverUpdateState.status === "idle" || serverUpdateState.status === "failed");

  const statusTooltip = `${
    unsupported
      ? (connectionErrorText(environment.connection, messages) ??
        connectionStatusText(environment.connection, messages))
      : enabled
        ? connectionStatusText(environment.connection)
        : "Off in this app"
  }${
    versionMismatch
      ? `\n${gt("Update available: {serverVersion} → {clientVersion}", {
          serverVersion: versionMismatch.serverVersion,
          clientVersion: versionMismatch.clientVersion,
        })}`
      : ""
  }`;

  return (
    <EnvironmentRow
      kind={machineKind}
      label={environment.label}
      dimmed={!enabled}
      subtitle={
        <span className="flex min-w-0 items-center gap-1">
          <Tooltip>
            {/* The status can change while the tooltip is open, and base-ui only
                re-measures the popup when the trigger's payload changes. */}
            <TooltipTrigger
              payload={statusTooltip}
              render={
                <span
                  className={cn(
                    "min-w-0 truncate",
                    enabled &&
                      status.tone === "error" &&
                      !resumingServerUpdate &&
                      !diagnosis &&
                      "text-destructive",
                  )}
                />
              }
            >
              {subtitleText}
            </TooltipTrigger>
            <TooltipPopup side="top" className="whitespace-pre-wrap">
              {statusTooltip}
            </TooltipPopup>
          </Tooltip>
          <span aria-hidden className="shrink-0">
            ·
          </span>
          <button
            type="button"
            aria-expanded={routesOpen}
            onClick={() => setRoutesOpen((open) => !open)}
            className="inline-flex shrink-0 items-center gap-0.5 rounded-sm text-muted-foreground outline-none hover:text-foreground focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring"
          >
            {routeCount === 1 ? gt("Routes") : `${routeCount} routes`}
            <ChevronRightIcon
              aria-hidden
              className={cn(
                "size-3 shrink-0 transition-transform duration-150 motion-reduce:transition-none",
                routesOpen && "rotate-90",
              )}
            />
          </button>
          <span aria-hidden className="shrink-0">
            ·
          </span>
          <button
            type="button"
            aria-expanded={permissionsOpen}
            aria-controls={`remote-permissions-${environmentId}`}
            onClick={() => setPermissionsOpen((open) => !open)}
            className="inline-flex shrink-0 items-center gap-0.5 rounded-sm text-muted-foreground outline-none hover:text-foreground focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring"
          >
            <T>Permissions</T>
            <ChevronRightIcon
              aria-hidden
              className={cn(
                "size-3 shrink-0 transition-transform duration-150 motion-reduce:transition-none",
                permissionsOpen && "rotate-90",
              )}
            />
          </button>
        </span>
      }
      below={
        <>
          {networkDetails.length > 0 ? (
            <p className="text-xs text-muted-foreground">{networkDetails.join(" · ")}</p>
          ) : null}
          {diagnosis ? (
            <ConnectionDiagnosisSummary
              diagnosis={diagnosis}
              retryAt={connectionState.phase === "backoff" ? connectionState.retryAt : null}
              attempt={connectionState.attempt}
              expanded={diagnosisOpen}
              onToggle={() => setDiagnosisOpen((open) => !open)}
            />
          ) : null}
          {serverUpdateState.status !== "idle" ? (
            <div className="mt-1 max-w-md">
              <ServerUpdateProgress state={serverUpdateState} />
            </div>
          ) : null}
        </>
      }
      detail={
        <>
          {diagnosis && diagnosisOpen ? (
            <ConnectionDiagnosisPanel
              hostLabel={environment.label}
              diagnosis={diagnosis}
              onRetry={() => void retryNow(environmentId)}
              onAddRoute={
                diagnosis.recovery === "pair-again" ? () => onAddRoute(environment) : null
              }
            />
          ) : null}
          {routesOpen && (
            <EnvironmentRoutesList
              environment={environment}
              onAddRoute={() => onAddRoute(environment)}
            />
          )}
          {permissionsOpen && (
            <div
              id={`remote-permissions-${environmentId}`}
              className="mt-2 border-t border-border/50"
            >
              <SessionPermissions
                environmentId={environmentId}
                connected={isConnected}
                routeContext
              />
            </div>
          )}
        </>
      }
    >
      {unsupported &&
      environment.entry.serverUpdateRequired === true &&
      serverUpdateState.status !== "running" ? (
        <OutdatedServerUpdateAction
          environmentId={environmentId}
          serverLabel={`${environment.label} server`}
          fromVersion={environment.serverConfig?.environment.serverVersion}
          targetVersion={APP_VERSION}
          label={serverUpdateState.status === "failed" ? gt("Retry update") : gt("Update")}
        />
      ) : null}
      {network?.actions}
      {showUpdateAction ? (
        <ServerUpdateAction
          environmentId={environmentId}
          serverLabel={gt("{label} server", {
            label: environment.label,
            $context: "names a Ada server inside sentences such as {serverLabel} updated",
          })}
          selfUpdate={resolveServerSelfUpdateCapability(environment.serverConfig)}
          installation={environment.serverConfig?.environment.capabilities.serverInstallation}
          desktopAppUpdate={supportsDesktopAppUpdate(environment.serverConfig)}
          targetVersion={versionMismatch.clientVersion}
          label={serverUpdateState.status === "failed" ? gt("Retry update") : gt("Update")}
          appearance="icon"
        />
      ) : null}
      <Tooltip>
        <TooltipTrigger
          render={
            <Switch
              size="sm"
              checked={enabled}
              disabled={isRemoving || blocked}
              aria-label={`Show ${environment.label} in this app`}
              onCheckedChange={(checked) => onSetEnabled(environmentId, checked)}
            />
          }
        />
        <TooltipPopup side="top">
          {blocked ? "Client not supported" : "Show in this app"}
        </TooltipPopup>
      </Tooltip>
      <EnvironmentActionsMenu
        environmentId={environmentId}
        label={environment.label}
        serverConfig={environment.serverConfig}
        disabled={isRemoving}
      >
        <MenuItem onClick={() => setRoutesOpen((open) => !open)}>
          <RouteIcon />
          {routesOpen ? "Hide routes" : "Routes"}
        </MenuItem>
        {mcpUrl ? (
          <MenuItem onClick={() => copyMcpUrl(mcpUrl, { url: mcpUrl })}>Copy MCP URL</MenuItem>
        ) : null}
        {errorTraceId ? (
          <MenuItem onClick={() => copyTraceId(errorTraceId)}>Copy trace ID</MenuItem>
        ) : null}
        {network?.menuItems}
        {network?.member === true ? null : (
          <>
            <MenuSeparator />
            <MenuItem variant="destructive" onClick={() => onRemove(environment)}>
              {isRemoving ? "Removing…" : "Remove from this device…"}
            </MenuItem>
          </>
        )}
      </EnvironmentActionsMenu>
      {network?.dialogs}
    </EnvironmentRow>
  );
}

function EmptyRemoteEnvironments() {
  return (
    <Empty className="min-h-52">
      <EmptyMedia variant="icon">
        <ChevronsLeftRightEllipsisIcon />
      </EmptyMedia>
      <EmptyHeader>
        <EmptyTitle>No other machines yet</EmptyTitle>
        <EmptyDescription>
          Ada machines on your Tailscale account show up here by themselves. To pair one that is
          not, click “Connect without Tailscale”.
        </EmptyDescription>
      </EmptyHeader>
    </Empty>
  );
}

export function RemoteEnvironmentsEmptyRow({
  savedEnvironments,
}: {
  readonly savedEnvironments: ReadonlyArray<EnvironmentPresentation>;
}) {
  return savedEnvironments.length === 0 ? <EmptyRemoteEnvironments /> : null;
}

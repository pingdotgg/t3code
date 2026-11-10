import { SessionPermissions } from "./SessionPermissions";
import {
  CheckIcon,
  ChevronRightIcon,
  ChevronsLeftRightEllipsisIcon,
  EllipsisIcon,
  PencilIcon,
  RouteIcon,
  XIcon,
} from "lucide-react";
import { useAtomValue } from "@effect/atom-react";
import { useEffect, useEffectEvent, useState } from "react";
import {
  AuthOrchestrationOperateScope,
  AuthRelayWriteScope,
  type EnvironmentId,
  connectReachabilityHelpUrl,
  formatConnectReachable,
  managedCapabilityDenial,
  resolveEnvironmentMachineKind,
} from "@t3tools/contracts";
import {
  connectionRoutes,
  hasSavedBearerRoute,
  connectionStatusText,
  environmentMcpUrl,
} from "@t3tools/client-runtime/connection";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import * as Option from "effect/Option";

import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import { cn } from "../../lib/utils";
import { SettingsRow, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import { EnvironmentDirectoryDisclosure } from "./EnvironmentDirectorySettings";
import { EnvironmentIconMenu } from "./EnvironmentIconPicker";
import { EnvironmentRoutesList } from "./EnvironmentRoutesList";
import {
  ConnectionDiagnosisPanel,
  ConnectionDiagnosisSummary,
  useConnectionDiagnosis,
} from "./ConnectionDiagnosisDetails";
import { useEnvironmentSessionState, usePreparedConnection } from "~/state/session";
import { EnvironmentRow, environmentTransportLabel } from "./EnvironmentRow";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Input } from "../ui/input";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "../ui/menu";
import { Spinner } from "../ui/spinner";
import { Switch } from "../ui/switch";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { Button, InlineButton } from "../ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "../ui/empty";
import {
  resolveServerConfigVersionMismatch,
  resolveServerSelfUpdateCapability,
  supportsDesktopAppUpdate,
} from "~/versionSkew";
import { hasClerkPublicConfig, hasCloudPublicConfig } from "~/cloud/publicConfig";
import { isElectron } from "~/env";
import { useOptionalConnectProviders } from "~/cloud/connectProviderContext";
import {
  canEmbedClerkProvider,
  currentEmbedContext,
  providerHasRelay,
} from "~/cloud/connectProviders";
import { useT3ConnectTurnOn } from "~/cloud/useT3ConnectTurnOn";
import { useCloudLinkController } from "~/cloud/useCloudLinkController";
import { useManagedTunnelUsage } from "~/cloud/managedRelayState";
import { useT3ConnectAccountPage } from "../clerk/T3ConnectAccountPages";
import { TunnelLimitAlert, TunnelUsageMeter } from "../cloud/TunnelUsage";
import { environmentCatalog } from "~/connection/catalog";
import { readEnvironmentScope } from "~/state/session";
import { type EnvironmentPresentation, useRelayEnvironmentDiscovery } from "~/state/environments";
import { APP_VERSION } from "~/branding";
import { useManagedPolicy } from "~/state/managedPolicy";
import { useAtomCommand } from "../../state/use-atom-command";
import { serverEnvironment } from "~/state/server";
import {
  OutdatedServerUpdateAction,
  ServerUpdateAction,
  ServerUpdateProgress,
} from "../ServerUpdateAction";
import { CloudEnvironmentConnectRows } from "../cloud/CloudEnvironmentConnectList";
import { useT3ConnectAuthPrompt } from "../clerk/useT3ConnectAuthPrompt";

type SavedBackendListRowProps = {
  environment: EnvironmentPresentation;
  environmentLabels: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly label: string;
  }>;
  removingEnvironmentId: EnvironmentId | null;
  onSetEnabled: (environmentId: EnvironmentId, enabled: boolean) => void;
  onRemove: (environment: EnvironmentPresentation) => void;
  onAddRoute: (environment: EnvironmentPresentation) => void;
};

export function EnvironmentLabelControl({
  environmentId,
  label,
  environmentLabels,
  canRename,
  showValue = false,
  valueClassName = "text-[13px] text-muted-foreground",
  valueElement: ValueElement = "span",
}: {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly environmentLabels: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly label: string;
  }>;
  readonly canRename: boolean;
  readonly showValue?: boolean;
  readonly valueClassName?: string;
  readonly valueElement?: "span" | "h3";
}) {
  const renameEnvironment = useAtomCommand(serverEnvironment.updateEnvironmentLabel, {
    reportFailure: false,
  });
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(label);
  const [saving, setSaving] = useState(false);
  const [pendingDuplicateLabel, setPendingDuplicateLabel] = useState<string | null>(null);

  if (!canRename && pendingDuplicateLabel !== null) setPendingDuplicateLabel(null);

  if (!canRename && !showValue) return null;

  const cancel = () => {
    setValue(label);
    setEditing(false);
  };
  const save = async (nextLabel: string) => {
    setSaving(true);
    const result = await renameEnvironment({ environmentId, input: nextLabel });
    setSaving(false);
    if (result._tag === "Success") {
      setEditing(false);
      return;
    }
    if (!isAtomCommandInterrupted(result)) {
      const error = squashAtomCommandFailure(result);
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Could not rename environment",
          description:
            error instanceof Error ? error.message : "The environment name was not saved.",
        }),
      );
    }
  };

  if (!editing || !canRename) {
    return (
      <>
        {showValue ? <ValueElement className={valueClassName}>{label}</ValueElement> : null}
        {canRename ? (
          <Button
            size="icon-micro"
            variant="ghost-muted"
            aria-label={`Rename ${label}`}
            onClick={() => {
              setValue(label);
              setEditing(true);
            }}
          >
            <PencilIcon className="size-3" />
          </Button>
        ) : null}
      </>
    );
  }

  return (
    <>
      <form
        className="flex min-w-0 items-center gap-1.5"
        onSubmit={(event) => {
          event.preventDefault();
          const nextLabel = value.trim();
          const duplicate =
            nextLabel.length > 0 &&
            environmentLabels.some(
              (environment) =>
                environment.environmentId !== environmentId && environment.label === nextLabel,
            );
          if (duplicate) {
            setPendingDuplicateLabel(nextLabel);
            return;
          }
          void save(nextLabel);
        }}
      >
        <Input
          autoFocus
          size="compact"
          className="w-48"
          aria-label="Environment name"
          maxLength={40}
          value={value}
          disabled={saving}
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== "Escape") return;
            event.preventDefault();
            event.stopPropagation();
            cancel();
          }}
        />
        <Button size="icon-xs" type="submit" disabled={saving} aria-label="Save environment name">
          {saving ? <Spinner className="size-3" /> : <CheckIcon className="size-3" />}
        </Button>
        <Button
          size="icon-xs"
          type="button"
          variant="ghost"
          disabled={saving}
          aria-label="Cancel environment rename"
          onClick={cancel}
        >
          <XIcon className="size-3" />
        </Button>
      </form>
      <AlertDialog
        open={pendingDuplicateLabel !== null}
        onOpenChange={(open) => {
          if (!open) setPendingDuplicateLabel(null);
        }}
      >
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Use this name twice?</AlertDialogTitle>
            <AlertDialogDescription>
              Another environment is already named “{pendingDuplicateLabel}”. Both environments will
              use the same name.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button type="button" variant="outline" />}>
              Cancel
            </AlertDialogClose>
            <Button
              type="button"
              onClick={() => {
                const nextLabel = pendingDuplicateLabel;
                setPendingDuplicateLabel(null);
                if (nextLabel !== null) void save(nextLabel);
              }}
            >
              Use name
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </>
  );
}

/**
 * Status word for a row subtitle: "Reconnecting: <reason>" instead of the
 * long-form sentence, since the row has one line and the full text is one
 * hover away.
 */
function savedBackendStatus(environment: EnvironmentPresentation): {
  readonly text: string;
  readonly tone: "muted" | "error";
} {
  if (!environment.entry.enabled && environment.connection.phase !== "unsupported")
    return { text: "Off", tone: "muted" };
  const { connection } = environment;
  switch (connection.phase) {
    case "connected":
      return { text: "Connected", tone: "muted" };
    case "connecting":
      return { text: "Connecting", tone: "muted" };
    case "reconnecting":
      return {
        text: connection.error ? `Reconnecting: ${connection.error}` : "Reconnecting",
        tone: "error",
      };
    case "unsupported":
      return { text: "Client not supported", tone: "muted" };
    case "error":
      return {
        text: connection.error ? `Connection failed: ${connection.error}` : "Connection failed",
        tone: "error",
      };
    case "offline":
      return { text: "Offline", tone: "muted" };
    case "available":
      return { text: "Not connected", tone: "muted" };
  }
}

export function SavedBackendListRow({
  environment,
  environmentLabels,
  removingEnvironmentId,
  onSetEnabled,
  onRemove,
  onAddRoute,
}: SavedBackendListRowProps) {
  const [routesOpen, setRoutesOpen] = useState(false);
  const [permissionsOpen, setPermissionsOpen] = useState(false);
  const [diagnosisOpen, setDiagnosisOpen] = useState(false);
  const environmentId = environment.environmentId;
  const unsupported = environment.connection.phase === "unsupported";
  const blocked = unsupported && !hasSavedBearerRoute(environment.entry);
  const enabled = environment.entry.enabled && !unsupported;
  const isConnected = environment.connection.phase === "connected";
  const sessionState = useEnvironmentSessionState(environmentId);
  const canRename =
    isConnected &&
    Boolean(
      sessionState.data?.authenticated &&
      sessionState.data.scopes?.includes(AuthOrchestrationOperateScope),
    );
  const isRemoving = removingEnvironmentId === environmentId;
  const errorTraceId = environment.connection.traceId;
  const { copyToClipboard: copyTraceIdToClipboard } = useCopyToClipboard<{ traceId: string }>({
    target: "trace ID",
    onCopy: ({ traceId }) => {
      toastManager.add({
        type: "success",
        title: "Trace ID copied",
        description: traceId,
      });
    },
    onError: (error) => {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Could not copy trace ID",
          description: error.message,
        }),
      );
    },
  });
  const copyTraceId = (traceId: string) => {
    copyTraceIdToClipboard(traceId, { traceId });
  };
  const { copyToClipboard: copyMcpUrl } = useCopyToClipboard<{ url: string }>({
    target: "MCP URL",
    onCopy: ({ url }) => {
      toastManager.add({
        type: "success",
        title: "MCP URL copied",
        description: `Add it to an agent, e.g. claude mcp add --transport http t3 ${url}`,
      });
    },
    onError: (error) => {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Could not copy MCP URL",
          description: error.message,
        }),
      );
    },
  });
  const versionMismatch = resolveServerConfigVersionMismatch(environment.serverConfig);
  const serverUpdateState = useAtomValue(serverEnvironment.updateStateAtom(environmentId));
  const resumingServerUpdate =
    serverUpdateState.status === "running" && serverUpdateState.stage === "resuming";
  const status = savedBackendStatus(environment);
  const serverVersion = environment.serverConfig?.environment.serverVersion ?? null;
  // Discovery empties its map on every refresh, so hold the last descriptor
  // seen or the glyph would blink back to the generic one each time.
  const relayDiscovery = useRelayEnvironmentDiscovery();
  const discoveredDescriptor = Option.getOrNull(
    relayDiscovery.environments.get(environmentId)?.status ?? Option.none(),
  )?.descriptor;
  const [lastDescriptor, setLastDescriptor] = useState(discoveredDescriptor);
  if (discoveredDescriptor !== undefined && discoveredDescriptor !== lastDescriptor) {
    setLastDescriptor(discoveredDescriptor);
  }
  const discoveredRelayHttpBaseUrl =
    relayDiscovery.environments.get(environmentId)?.environment.endpoint.httpBaseUrl;
  const [lastRelayHttpBaseUrl, setLastRelayHttpBaseUrl] = useState(discoveredRelayHttpBaseUrl);
  if (
    discoveredRelayHttpBaseUrl !== undefined &&
    discoveredRelayHttpBaseUrl !== lastRelayHttpBaseUrl
  ) {
    setLastRelayHttpBaseUrl(discoveredRelayHttpBaseUrl);
  }
  const retryNow = useAtomCommand(environmentCatalog.retryNow);
  const {
    diagnosis: currentDiagnosis,
    state: connectionState,
    relayOnly,
  } = useConnectionDiagnosis(environment);
  const diagnosis = resumingServerUpdate ? null : currentDiagnosis;
  const prepared = usePreparedConnection(environmentId);
  const connectedTarget = isConnected && prepared._tag === "Some" ? prepared.value.target : null;
  const mcpUrl = environmentMcpUrl({
    entry: environment.entry,
    relayHttpBaseUrl: discoveredRelayHttpBaseUrl ?? lastRelayHttpBaseUrl,
    connectedTarget,
  });
  const machineKind = resolveEnvironmentMachineKind(
    environment.serverConfig ??
      (lastDescriptor === undefined ? null : { environment: lastDescriptor }),
  );
  const routeCount = connectionRoutes(environment.entry).length;
  const subtitleText = [
    environmentTransportLabel(environment, connectedTarget),
    // The headline below names the failure in full.
    diagnosis ? null : resumingServerUpdate ? "Restarting" : status.text,
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
      ? (environment.connection.error ?? connectionStatusText(environment.connection))
      : enabled
        ? connectionStatusText(environment.connection)
        : "Switched off"
  }${
    versionMismatch
      ? `\nUpdate available: ${versionMismatch.serverVersion} → ${versionMismatch.clientVersion}`
      : ""
  }`;

  return (
    <EnvironmentRow
      kind={machineKind}
      label={environment.label}
      labelSlot={
        canRename ? (
          <div className="flex min-w-0 items-center gap-1">
            <EnvironmentLabelControl
              environmentId={environmentId}
              label={environment.label}
              environmentLabels={environmentLabels}
              canRename
              showValue
              valueClassName="min-w-0 truncate text-sm font-medium text-foreground"
            />
          </div>
        ) : undefined
      }
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
            {routeCount === 1 ? "Routes" : `${routeCount} routes`}
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
            Permissions
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
          <EnvironmentDirectoryDisclosure environment={environment} />
        </>
      }
      detail={
        <>
          {diagnosis && diagnosisOpen ? (
            <ConnectionDiagnosisPanel
              hostLabel={environment.label}
              diagnosis={diagnosis}
              onRetry={() => void retryNow(environmentId)}
              onAddRoute={relayOnly ? () => onAddRoute(environment) : null}
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
          fromVersion={lastDescriptor?.serverVersion}
          targetVersion={APP_VERSION}
          label={serverUpdateState.status === "failed" ? "Retry update" : "Update"}
        />
      ) : null}
      {showUpdateAction ? (
        <ServerUpdateAction
          environmentId={environmentId}
          serverLabel={`${environment.label} server`}
          selfUpdate={resolveServerSelfUpdateCapability(environment.serverConfig)}
          installation={environment.serverConfig?.environment.capabilities.serverInstallation}
          desktopAppUpdate={supportsDesktopAppUpdate(environment.serverConfig)}
          targetVersion={versionMismatch.clientVersion}
          label={serverUpdateState.status === "failed" ? "Retry update" : "Update"}
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
              aria-label={`${enabled ? "Switch off" : "Switch on"} ${environment.label}`}
              onCheckedChange={(checked) => onSetEnabled(environmentId, checked)}
            />
          }
        />
        <TooltipPopup side="top">
          {blocked ? "Client not supported" : enabled ? "Switch off" : "Switch on"}
        </TooltipPopup>
      </Tooltip>
      <Menu>
        <MenuTrigger
          render={
            <Button
              type="button"
              variant="ghost-muted"
              size="icon-xs"
              disabled={isRemoving}
              aria-label={`More actions for ${environment.label}`}
            />
          }
        >
          <EllipsisIcon className="size-3.5" />
        </MenuTrigger>
        <MenuPopup align="end">
          <EnvironmentIconMenu
            environmentId={environmentId}
            serverConfig={environment.serverConfig}
          />
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
          <MenuSeparator />
          <MenuItem variant="destructive" onClick={() => onRemove(environment)}>
            {isRemoving ? "Removing…" : "Remove from this device…"}
          </MenuItem>
        </MenuPopup>
      </Menu>
    </EnvironmentRow>
  );
}

function CloudLinkSwitch({
  checked,
  disabled,
  disabledReason,
  onCheckedChange,
  ariaLabel = "Enable T3 Connect",
}: {
  readonly checked: boolean;
  readonly disabled: boolean;
  readonly disabledReason: string | null;
  readonly onCheckedChange?: (enabled: boolean) => void;
  readonly ariaLabel?: string;
}) {
  const control = (
    <Switch
      aria-label={ariaLabel}
      checked={checked}
      disabled={disabled}
      {...(onCheckedChange ? { onCheckedChange } : {})}
    />
  );
  return disabledReason ? (
    <Tooltip>
      <TooltipTrigger render={<span className="inline-flex">{control}</span>} />
      <TooltipPopup side="top">{disabledReason}</TooltipPopup>
    </Tooltip>
  ) : (
    control
  );
}

/** Tunnel meter, plus the upgrade prompt after the relay refuses a tunnel at the cap. */
function T3ConnectTunnelUsage({ tunnelLimit }: { readonly tunnelLimit: number | null }) {
  const usage = useManagedTunnelUsage();
  const accountPage = useT3ConnectAccountPage();
  const openAccountPage = accountPage.open;
  // Usage when the relay refused. The relay also counts tunnels still being set up, so only
  // a freed tunnel or a higher cap clears the alert, not a meter that merely shows room.
  const [usedAtRefusal, setUsedAtRefusal] = useState<number | null>(null);
  if (tunnelLimit === null) {
    if (usedAtRefusal !== null) setUsedAtRefusal(null);
  } else if (usedAtRefusal === null && usage.used !== null) {
    setUsedAtRefusal(usage.used);
  }
  const showLimitAlert =
    tunnelLimit !== null &&
    !(usedAtRefusal !== null && usage.used !== null && usage.used < usedAtRefusal) &&
    !(usage.limit !== null && usage.limit > tunnelLimit);
  const meter =
    usage.used !== null && usage.limit !== null ? (
      <TunnelUsageMeter
        used={usage.used}
        limit={usage.limit}
        action={
          // At the cap the alert below carries the same actions.
          !openAccountPage || showLimitAlert ? null : usage.upgrade ? (
            <InlineButton onClick={() => openAccountPage("t3-chat")}>Get more tunnels</InlineButton>
          ) : usage.used >= usage.limit ? (
            <InlineButton onClick={() => openAccountPage("t3-connect")}>
              Manage tunnels
            </InlineButton>
          ) : null
        }
      />
    ) : null;
  return (
    <>
      {meter || showLimitAlert ? (
        <div className="flex flex-col gap-3 pb-3">
          {meter}
          {showLimitAlert ? (
            <TunnelLimitAlert
              upgrade={usage.upgrade}
              onLinkT3Chat={openAccountPage ? () => openAccountPage("t3-chat") : null}
              onManageTunnels={openAccountPage ? () => openAccountPage("t3-connect") : null}
            />
          ) : null}
        </div>
      ) : null}
      {/* Kept outside the conditional so an open account page does not remount. */}
      {accountPage.portals}
    </>
  );
}

function ConfiguredCloudLinkRow({
  environmentId,
  canManageRelay,
}: {
  readonly environmentId: EnvironmentId;
  readonly canManageRelay: boolean;
}) {
  const {
    isSignedIn,
    linkState: cloudLinkState,
    linkRevoked,
    managedTunnelActive,
    managedTunnelOutOfSync,
    publishAgentActivity,
    holdWebhooksWhileOffline,
    operationError,
    tunnelLimit,
    reconcileCloudState,
  } = useCloudLinkController(environmentId);
  const { openAuthPrompt } = useT3ConnectAuthPrompt();
  const connect = useOptionalConnectProviders();
  // Label + relay checks follow the Clerk instance that is actually mounted.
  const embeddedProvider = connect?.embedded ?? null;
  const connectLabel = embeddedProvider?.label ?? "Connect";
  const hasRelay = providerHasRelay(embeddedProvider);
  // The server unlinks and refuses relay changes under such a policy; unlinking stays possible.
  const connectDenial = managedCapabilityDenial(useManagedPolicy(environmentId), "connect");
  const turnOn = useT3ConnectTurnOn(environmentId);
  // Turning on links from this desktop's own backend only; turning off works from anywhere.
  const showSwitch = isElectron && (turnOn.kind !== "on-host" || managedTunnelActive);
  const [isUpdating, setIsUpdating] = useState(false);
  const [isUpdatingPreference, setIsUpdatingPreference] = useState(false);

  const disabledReason = canManageRelay
    ? null
    : `Your session does not have permission to manage ${connectLabel} access.`;
  // Publish works without a managed tunnel; Share needs an https relay URL on
  // the embedded Connect provider.
  const shareDisabledReason =
    disabledReason ??
    (!hasRelay
      ? `${connectLabel} has no managed relay. Publish agent activity still works; Share needs one.`
      : null);
  const isBusy = isUpdating || isUpdatingPreference;
  const switchDisabled =
    !canManageRelay ||
    !isSignedIn ||
    cloudLinkState.data === null ||
    cloudLinkState.isPending ||
    isBusy;
  // `isSignedIn` is undefined until Clerk loads. Signed out, one row shows a
  // sign-in button instead of its switch; the onboarding dialog that opens after
  // a fresh sign-in offers both linking and publishing.
  const signedOut = isSignedIn === false;
  const signInButton = (
    <Button size="sm" variant="outline" onClick={openAuthPrompt}>
      Sign in
    </Button>
  );
  const refreshLinkState = useEffectEvent(cloudLinkState.refresh);
  // The server rechecks reachability when the tunnel's 30 s readiness poll changes.
  // Poll while mounted, so a failed read does not stop later ones.
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- 30 s interval that refreshes the cloud link reachability while mounted
  useEffect(() => {
    const interval = window.setInterval(() => refreshLinkState(), 30_000);
    return () => window.clearInterval(interval);
  }, []);
  const reachability = managedTunnelActive ? cloudLinkState.data?.reachability : undefined;
  const reachabilityStatus =
    reachability?.status === "reachable" ? (
      formatConnectReachable(reachability)
    ) : reachability?.status === "unreachable" ? (
      <span className="block text-destructive">
        {[reachability.reason, reachability.hint, `Fix: ${reachability.fix}`]
          .filter(Boolean)
          .join(" ")}{" "}
        <a
          href={connectReachabilityHelpUrl(reachability.cause)}
          target="_blank"
          rel="noreferrer"
          className="underline underline-offset-2"
        >
          More info
        </a>
      </span>
    ) : null;

  const updateManagedTunnel = async (enabled: boolean) => {
    if (!readEnvironmentScope(environmentId, AuthRelayWriteScope)) return;
    setIsUpdating(true);
    const ok = await reconcileCloudState({ managedTunnel: enabled, publish: publishAgentActivity });
    if (ok) {
      toastManager.add({
        type: "success",
        title: enabled
          ? `${connectLabel} linked`
          : publishAgentActivity
            ? `${connectLabel} tunnel disabled`
            : `${connectLabel} unlinked`,
        description: enabled
          ? `This environment is available through ${connectLabel}.`
          : publishAgentActivity
            ? "The managed tunnel was removed. Agent activity publishing stays on."
            : `This environment is no longer available through ${connectLabel}.`,
      });
    }
    setIsUpdating(false);
  };

  const updatePublishAgentActivity = async (enabled: boolean) => {
    if (!readEnvironmentScope(environmentId, AuthRelayWriteScope)) return;
    setIsUpdatingPreference(true);
    const ok = await reconcileCloudState({ managedTunnel: managedTunnelActive, publish: enabled });
    if (ok) {
      toastManager.add({
        type: "success",
        title: enabled ? "Agent activity enabled" : "Agent activity disabled",
        description: enabled
          ? "This environment publishes agent activity to your mobile clients."
          : "This environment will stop publishing agent activity.",
      });
    }
    setIsUpdatingPreference(false);
  };

  const updateHoldWebhooks = async (enabled: boolean) => {
    setIsUpdatingPreference(true);
    const ok = await reconcileCloudState({
      managedTunnel: managedTunnelActive,
      publish: publishAgentActivity,
      holdWebhooksWhileOffline: enabled,
    });
    if (ok) {
      toastManager.add({
        type: "success",
        title: enabled ? "Webhooks held while offline" : "Webhooks no longer held",
        description: enabled
          ? `${connectLabel} keeps webhook requests for up to 24 hours while this environment is offline.`
          : "Requests to an offline environment now fail. Anything already held is still delivered.",
      });
    }
    setIsUpdatingPreference(false);
  };

  return (
    <>
      {showSwitch ? (
        <SettingsRow
          title={`Share via ${connectLabel}`}
          description={
            connectDenial !== undefined && !managedTunnelActive
              ? connectDenial
              : signedOut
                ? `Sign in to make this environment available to your other devices through ${connectLabel}.`
                : !hasRelay
                  ? `Sharing needs a managed ${connectLabel} relay. Publish agent activity still works without one.`
                  : linkRevoked
                    ? `This environment was removed from ${connectLabel}. Turn it on to link it again.`
                    : managedTunnelActive
                      ? reachability?.status === "unreachable"
                        ? `${connectLabel} is on, but other devices cannot reach this environment.`
                        : reachability?.status === "reachable"
                          ? `This environment is available to your other devices through ${connectLabel}.`
                          : `${connectLabel} is on. Reachability has not been checked yet.`
                      : managedTunnelOutOfSync
                        ? `${connectLabel} is out of sync. This environment is linked only to publish agent activity, so other devices cannot connect. Turn ${connectLabel} on to repair it.`
                        : `Make this environment available to your other devices through ${connectLabel}.`
          }
          status={operationError ?? cloudLinkState.error ?? reachabilityStatus}
          managed={managedTunnelActive ? undefined : connectDenial}
          control={
            signedOut ? (
              signInButton
            ) : (
              <CloudLinkSwitch
                ariaLabel={`Share this environment via ${connectLabel}`}
                checked={managedTunnelActive}
                disabled={switchDisabled || !hasRelay}
                disabledReason={shareDisabledReason}
                onCheckedChange={(enabled) => void updateManagedTunnel(enabled)}
              />
            )
          }
        >
          {signedOut || connectDenial !== undefined ? null : (
            <T3ConnectTunnelUsage tunnelLimit={tunnelLimit} />
          )}
        </SettingsRow>
      ) : linkRevoked ? (
        <SettingsRow
          title={searchableSetting("t3-connect").title}
          description={`This environment was removed from ${connectLabel}. Run \`t3 connect link\` on the host to link it again.`}
        />
      ) : isElectron ? (
        <SettingsRow
          title={searchableSetting("t3-connect").title}
          description="Run `t3 connect link` on the host, then restart T3 Code there."
        />
      ) : null}
      {signedOut && showSwitch ? null : (
        <SettingsRow
          title={searchableSetting("publish-agent-activity").title}
          description={
            signedOut
              ? "Sign in to send activity to mobile notifications and Live Activities."
              : `Send activity to mobile notifications and Live Activities without ${connectLabel}.`
          }
          managed={connectDenial}
          control={
            signedOut ? (
              signInButton
            ) : (
              <CloudLinkSwitch
                ariaLabel="Publish agent activity to mobile clients"
                checked={publishAgentActivity}
                disabled={switchDisabled}
                disabledReason={disabledReason}
                onCheckedChange={(enabled) => void updatePublishAgentActivity(enabled)}
              />
            )
          }
        />
      )}
      {managedTunnelActive && !signedOut ? (
        <SettingsRow
          title={searchableSetting("hold-webhooks-while-offline").title}
          description={`Keep webhook requests for up to 24 hours while this environment is offline, then deliver them. Off: ${connectLabel} only forwards requests and stores nothing.`}
          managed={connectDenial}
          control={
            <CloudLinkSwitch
              ariaLabel="Hold webhook requests while this environment is offline"
              checked={holdWebhooksWhileOffline}
              disabled={switchDisabled}
              disabledReason={disabledReason}
              onCheckedChange={(enabled) => void updateHoldWebhooks(enabled)}
            />
          }
        />
      ) : null}
    </>
  );
}

export function ConnectAccountsSection() {
  const connect = useOptionalConnectProviders();
  const providers = connect?.providers ?? [];
  const embedded = connect?.embedded ?? null;
  const ctx = currentEmbedContext();
  if (providers.length === 0 && !hasClerkPublicConfig()) return null;

  const embeddableProviders = providers.filter((provider) => canEmbedClerkProvider(provider, ctx));
  const externalT3 =
    providers.find(
      (provider) =>
        provider.id === "t3" && !canEmbedClerkProvider(provider, ctx) && provider.hostedAppUrl,
    ) ?? null;

  const only = embeddableProviders[0] ?? providers[0];
  if (!only) return null;
  return (
    <SettingsSection title="Connect">
      <SettingsRow
        title={embedded?.label ?? only.label}
        description={
          embedded
            ? "T3 identity for T3-linked machines and the T3 relay."
            : "Sign in from the sidebar to use Connect."
        }
        control={
          externalT3 ? (
            <Button
              size="xs"
              variant="outline"
              onClick={() => {
                window.open(externalT3.hostedAppUrl, "_blank", "noopener,noreferrer");
              }}
            >
              Open T3 Connect
            </Button>
          ) : (
            <span className="text-xs text-muted-foreground">Active</span>
          )
        }
      />
    </SettingsSection>
  );
}

export function CloudLinkRow({
  environmentId,
  canReadRelay,
  canManageRelay,
}: {
  readonly environmentId: EnvironmentId;
  readonly canReadRelay: boolean;
  readonly canManageRelay: boolean;
}) {
  const connectLabel = useOptionalConnectProviders()?.embedded?.label ?? "Connect";
  // Publish works with Clerk alone; Share still gates on an https relay inside
  // ConfiguredCloudLinkRow, so the section stays even without one.
  if (!hasClerkPublicConfig() && !hasCloudPublicConfig()) return null;
  if (!canReadRelay) {
    return (
      <SettingsRow
        title={connectLabel}
        description="To edit these settings, pair this connection with both View relay and Manage relay permissions."
      />
    );
  }
  return <ConfiguredCloudLinkRow environmentId={environmentId} canManageRelay={canManageRelay} />;
}

function EmptyRemoteEnvironments({ cloudEnabled = true }: { readonly cloudEnabled?: boolean }) {
  return (
    <Empty className="min-h-52">
      <EmptyMedia variant="icon">
        <ChevronsLeftRightEllipsisIcon />
      </EmptyMedia>
      <EmptyHeader>
        <EmptyTitle>No saved remote environments</EmptyTitle>
        <EmptyDescription>
          {cloudEnabled
            ? "Click “Add environment” to pair another environment, or connect one from MT Connect or T3 Connect."
            : "Click “Add environment” to pair another environment."}
        </EmptyDescription>
      </EmptyHeader>
    </Empty>
  );
}

export function CloudRemoteEnvironmentRows({
  primaryEnvironmentId,
  savedEnvironments,
}: {
  readonly primaryEnvironmentId: EnvironmentId | null;
  readonly savedEnvironments: ReadonlyArray<EnvironmentPresentation>;
}) {
  return hasCloudPublicConfig() ? (
    <CloudEnvironmentConnectRows
      primaryEnvironmentId={primaryEnvironmentId}
      savedEnvironments={savedEnvironments}
      empty={<EmptyRemoteEnvironments />}
    />
  ) : savedEnvironments.length === 0 ? (
    <EmptyRemoteEnvironments cloudEnabled={false} />
  ) : null;
}

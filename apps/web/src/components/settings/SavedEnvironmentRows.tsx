import { managedCapabilityDenial } from "@t3tools/client-runtime/contract-labels";
import { SessionPermissions } from "./SessionPermissions";
import {
  ChevronRightIcon,
  ChevronsLeftRightEllipsisIcon,
  EllipsisIcon,
  RouteIcon,
} from "lucide-react";
import { useAtomValue } from "@effect/atom-react";
import { useEffect, useEffectEvent, useState } from "react";
import {
  AuthRelayWriteScope,
  type EnvironmentId,
  connectReachabilityHelpUrl,
  formatConnectReachable,
  resolveEnvironmentMachineKind,
} from "@t3tools/contracts";
import {
  connectionRoutes,
  hasSavedBearerRoute,
  connectionErrorText,
  connectionStatusText,
  environmentMcpUrl,
} from "@t3tools/client-runtime/connection";
import * as Option from "effect/Option";
import { msg, T, useGT, useMessages } from "gt-react";
import { m, type MessageResolver } from "../../i18n/messages";

import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import { cn } from "../../lib/utils";
import { SettingsRow } from "./settingsLayout";
import { useSearchableSetting } from "./settingsSearch";
import { EnvironmentIconMenu } from "./EnvironmentIconPicker";
import { EnvironmentRoutesList } from "./EnvironmentRoutesList";
import {
  ConnectionDiagnosisPanel,
  ConnectionDiagnosisSummary,
  useConnectionDiagnosis,
} from "./ConnectionDiagnosisDetails";
import { usePreparedConnection } from "~/state/session";
import { EnvironmentRow, environmentTransportLabel } from "./EnvironmentRow";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "../ui/menu";
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
import { hasCloudPublicConfig } from "~/cloud/publicConfig";
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
import { useUpdateEnvironmentSettings } from "~/hooks/useSettings";
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
  removingEnvironmentId: EnvironmentId | null;
  onSetEnabled: (environmentId: EnvironmentId, enabled: boolean) => void;
  onRemove: (environment: EnvironmentPresentation) => void;
  onAddRoute: (environment: EnvironmentPresentation) => void;
  /** The map's details open on a machine's routes; the list keeps them folded. */
  initialRoutesOpen?: boolean;
};

export function savedBackendStatus(
  environment: EnvironmentPresentation,
  resolve: MessageResolver = m,
): {
  readonly text: string;
  readonly tone: "muted" | "error";
} {
  if (!environment.entry.enabled && environment.connection.phase !== "unsupported")
    return { text: resolve(msg("Off", { $context: "environment switched off" })), tone: "muted" };
  const { connection } = environment;
  const error = connectionErrorText(connection, resolve);
  switch (connection.phase) {
    case "connected":
      return { text: resolve(msg("Connected")), tone: "muted" };
    case "connecting":
      return { text: resolve(msg("Connecting")), tone: "muted" };
    case "reconnecting":
      if (connection.awaitingApproval) {
        return { text: error ?? resolve(msg("Waiting for approval")), tone: "muted" };
      }
      return {
        text: error
          ? resolve(msg("Reconnecting: {error}", { error }))
          : resolve(msg("Reconnecting")),
        tone: "error",
      };
    case "unsupported":
      return { text: resolve(msg("Client not supported")), tone: "muted" };
    case "error":
      return {
        text: error
          ? resolve(msg("Connection failed: {error}", { error }))
          : resolve(msg("Connection failed")),
        tone: "error",
      };
    case "offline":
      return { text: resolve(msg("Offline")), tone: "muted" };
    case "available":
      return { text: resolve(msg("Not connected")), tone: "muted" };
  }
}

export function SavedBackendListRow({
  environment,
  removingEnvironmentId,
  onSetEnabled,
  onRemove,
  onAddRoute,
  initialRoutesOpen = false,
}: SavedBackendListRowProps) {
  const messages = useMessages();
  const gt = useGT();
  const [routesOpen, setRoutesOpen] = useState(initialRoutesOpen);
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
  const status = savedBackendStatus(environment, messages);
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
    environmentTransportLabel(environment, connectedTarget, messages),
    // The headline below names the failure in full.
    diagnosis ? null : resumingServerUpdate ? gt("Restarting") : status.text,
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
        ? connectionStatusText(environment.connection, messages)
        : gt("Switched off")
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
          serverLabel={gt("{label} server", {
            label: environment.label,
            $context: "names a T3 server inside sentences such as {serverLabel} updated",
          })}
          fromVersion={lastDescriptor?.serverVersion}
          targetVersion={APP_VERSION}
          label={serverUpdateState.status === "failed" ? gt("Retry update") : gt("Update")}
        />
      ) : null}
      {showUpdateAction ? (
        <ServerUpdateAction
          environmentId={environmentId}
          serverLabel={gt("{label} server", {
            label: environment.label,
            $context: "names a T3 server inside sentences such as {serverLabel} updated",
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
              aria-label={
                enabled
                  ? gt("Switch off {label}", { label: environment.label })
                  : gt("Switch on {label}", { label: environment.label })
              }
              onCheckedChange={(checked) => onSetEnabled(environmentId, checked)}
            />
          }
        />
        <TooltipPopup side="top">
          {blocked ? gt("Client not supported") : enabled ? gt("Switch off") : gt("Switch on")}
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
              aria-label={gt("More actions for {label}", { label: environment.label })}
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
            {routesOpen ? gt("Hide routes") : gt("Routes")}
          </MenuItem>
          {mcpUrl ? (
            <MenuItem onClick={() => copyMcpUrl(mcpUrl, { url: mcpUrl })}>
              <T>Copy MCP URL</T>
            </MenuItem>
          ) : null}
          {errorTraceId ? (
            <MenuItem onClick={() => copyTraceId(errorTraceId)}>
              <T>Copy trace ID</T>
            </MenuItem>
          ) : null}
          <MenuSeparator />
          <MenuItem variant="destructive" onClick={() => onRemove(environment)}>
            {isRemoving ? gt("Removing…") : gt("Remove from this device…")}
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
  ariaLabel,
}: {
  readonly checked: boolean;
  readonly disabled: boolean;
  readonly disabledReason: string | null;
  readonly onCheckedChange?: (enabled: boolean) => void;
  readonly ariaLabel?: string;
}) {
  const gt = useGT();
  const control = (
    <Switch
      aria-label={ariaLabel ?? gt("Enable T3 Connect")}
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
            <InlineButton onClick={() => openAccountPage("t3-chat")}>
              <T>Get more tunnels</T>
            </InlineButton>
          ) : usage.used >= usage.limit ? (
            <InlineButton onClick={() => openAccountPage("t3-connect")}>
              <T>Manage tunnels</T>
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
  connectDeviceApproval,
}: {
  readonly environmentId: EnvironmentId;
  readonly canManageRelay: boolean;
  readonly connectDeviceApproval: ConnectDeviceApprovalControl | null;
}) {
  const setting = useSearchableSetting();
  const gt = useGT();
  const updateEnvironmentSettings = useUpdateEnvironmentSettings(environmentId);
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
    needsRelayConfiguration,
    reconcileCloudState,
  } = useCloudLinkController(environmentId);
  const { openAuthPrompt } = useT3ConnectAuthPrompt();
  // The server unlinks and refuses relay changes under such a policy; unlinking stays possible.
  const messages = useMessages();
  const connectDenial = managedCapabilityDenial(
    useManagedPolicy(environmentId),
    "connect",
    messages,
  );
  const turnOn = useT3ConnectTurnOn(environmentId);
  // Turning on needs relay configuration permission; turning off works from anywhere.
  const showSwitch = turnOn.kind !== "on-host" || managedTunnelActive;
  const [isUpdating, setIsUpdating] = useState(false);
  const [isUpdatingPreference, setIsUpdatingPreference] = useState(false);

  const disabledReason = canManageRelay
    ? null
    : gt("Your session does not have permission to manage T3 Connect access.");
  const isBusy = isUpdating || isUpdatingPreference;
  const switchDisabled =
    !canManageRelay ||
    !isSignedIn ||
    cloudLinkState.data === null ||
    cloudLinkState.isPending ||
    isBusy;
  const configureReason = gt(
    "This connection needs the relay configuration permission to configure T3 Connect.",
  );
  const tunnelNeedsConfigure = needsRelayConfiguration({
    managedTunnel: !managedTunnelActive,
    publish: publishAgentActivity,
  });
  const publishNeedsConfigure = needsRelayConfiguration({
    managedTunnel: managedTunnelActive,
    publish: !publishAgentActivity,
  });
  // `isSignedIn` is undefined until Clerk loads. Signed out, one row shows a
  // sign-in button instead of its switch; the onboarding dialog that opens after
  // a fresh sign-in offers both linking and publishing.
  const signedOut = isSignedIn === false;
  const signInButton = (
    <Button size="sm" variant="outline" onClick={openAuthPrompt}>
      <T>Sign in</T>
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
        {[reachability.reason, reachability.hint, gt("Fix: {fix}", { fix: reachability.fix })]
          .filter(Boolean)
          .join(" ")}{" "}
        <a
          href={connectReachabilityHelpUrl(reachability.cause)}
          target="_blank"
          rel="noreferrer"
          className="underline underline-offset-2"
        >
          <T>More info</T>
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
          ? gt("T3 Connect linked")
          : publishAgentActivity
            ? gt("T3 Connect tunnel disabled")
            : gt("T3 Connect unlinked"),
        description: enabled
          ? gt("This environment is available through T3 Connect.")
          : publishAgentActivity
            ? gt("The managed tunnel was removed. Agent activity publishing stays on.")
            : gt("This environment is no longer available through T3 Connect."),
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
        title: enabled ? gt("Agent activity enabled") : gt("Agent activity disabled"),
        description: enabled
          ? gt("This environment publishes agent activity to your mobile clients.")
          : gt("This environment will stop publishing agent activity."),
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
        title: enabled ? gt("Webhooks held while offline") : gt("Webhooks no longer held"),
        description: enabled
          ? gt(
              "T3 Connect keeps webhook requests for up to 24 hours while this environment is offline.",
            )
          : gt(
              "Requests to an offline environment now fail. Anything already held is still delivered.",
            ),
      });
    }
    setIsUpdatingPreference(false);
  };

  return (
    <>
      {showSwitch ? (
        <SettingsRow
          title={setting("t3-connect").title}
          description={
            connectDenial !== undefined && !managedTunnelActive
              ? connectDenial
              : signedOut
                ? gt(
                    "Sign in to make this environment available to your other devices through T3 Connect.",
                  )
                : linkRevoked
                  ? gt("This environment was removed from T3 Connect. Turn it on to link it again.")
                  : managedTunnelActive
                    ? reachability?.status === "unreachable"
                      ? gt("T3 Connect is on, but other devices cannot reach this environment.")
                      : reachability?.status === "reachable"
                        ? gt(
                            "This environment is available to your other devices through T3 Connect.",
                          )
                        : gt("T3 Connect is on. Reachability has not been checked yet.")
                    : managedTunnelOutOfSync
                      ? gt(
                          "T3 Connect is out of sync. This environment is linked only to publish agent activity, so other devices cannot connect. Turn T3 Connect on to repair it.",
                        )
                      : gt(
                          "Make this environment available to your other devices through T3 Connect.",
                        )
          }
          status={operationError ?? cloudLinkState.error ?? reachabilityStatus}
          managed={managedTunnelActive ? undefined : connectDenial}
          control={
            signedOut ? (
              signInButton
            ) : (
              <CloudLinkSwitch
                checked={managedTunnelActive}
                disabled={switchDisabled || tunnelNeedsConfigure}
                disabledReason={disabledReason ?? (tunnelNeedsConfigure ? configureReason : null)}
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
          title={setting("t3-connect").title}
          description={gt(
            "This environment was removed from T3 Connect. Run `t3 connect link` on the host to link it again.",
          )}
        />
      ) : (
        <SettingsRow
          title={setting("t3-connect").title}
          description={gt("Run `t3 connect link` on the host, then restart T3 Code there.")}
        />
      )}
      {signedOut && showSwitch ? null : (
        <SettingsRow
          title={setting("publish-agent-activity").title}
          description={
            signedOut
              ? gt("Sign in to send activity to mobile notifications and Live Activities.")
              : gt("Send activity to mobile notifications and Live Activities without T3 Connect.")
          }
          managed={connectDenial}
          control={
            signedOut ? (
              signInButton
            ) : (
              <CloudLinkSwitch
                ariaLabel={gt("Publish agent activity to mobile clients")}
                checked={publishAgentActivity}
                disabled={switchDisabled || publishNeedsConfigure}
                disabledReason={disabledReason ?? (publishNeedsConfigure ? configureReason : null)}
                onCheckedChange={(enabled) => void updatePublishAgentActivity(enabled)}
              />
            )
          }
        />
      )}
      {managedTunnelActive && !signedOut ? (
        <SettingsRow
          title={setting("hold-webhooks-while-offline").title}
          description={gt(
            "Keep webhook requests for up to 24 hours while this environment is offline, then deliver them. Off: T3 Connect only forwards requests and stores nothing.",
          )}
          managed={connectDenial}
          control={
            <CloudLinkSwitch
              ariaLabel={gt("Hold webhook requests while this environment is offline")}
              checked={holdWebhooksWhileOffline}
              disabled={switchDisabled}
              disabledReason={disabledReason}
              onCheckedChange={(enabled) => void updateHoldWebhooks(enabled)}
            />
          }
        />
      ) : null}
      {managedTunnelActive && connectDeviceApproval ? (
        <SettingsRow
          title={setting("connect-device-approval").title}
          description={gt(
            "Devices that sign in to your T3 Connect account wait until someone already connected here approves them.",
          )}
          managed={connectDenial}
          control={
            <CloudLinkSwitch
              ariaLabel={gt("Require approval for new T3 Connect devices")}
              checked={connectDeviceApproval.required}
              disabled={!connectDeviceApproval.canManage}
              disabledReason={
                connectDeviceApproval.canManage
                  ? null
                  : gt("Your session does not have permission to manage access.")
              }
              onCheckedChange={(enabled) =>
                updateEnvironmentSettings({ requireConnectDeviceApproval: enabled })
              }
            />
          }
        />
      ) : null}
    </>
  );
}

/** Older servers have no device approval, so callers pass null and the row stays hidden. */
export interface ConnectDeviceApprovalControl {
  readonly required: boolean;
  readonly canManage: boolean;
}

export function CloudLinkRow({
  environmentId,
  canReadRelay,
  canManageRelay,
  connectDeviceApproval,
}: {
  readonly environmentId: EnvironmentId;
  readonly canReadRelay: boolean;
  readonly canManageRelay: boolean;
  readonly connectDeviceApproval: ConnectDeviceApprovalControl | null;
}) {
  const gt = useGT();
  if (!hasCloudPublicConfig()) return null;
  if (!canReadRelay) {
    return (
      <SettingsRow
        title={gt("T3 Connect")}
        description={gt(
          "To edit these settings, pair this connection with both View relay and Manage relay permissions.",
        )}
      />
    );
  }
  return (
    <ConfiguredCloudLinkRow
      environmentId={environmentId}
      canManageRelay={canManageRelay}
      connectDeviceApproval={connectDeviceApproval}
    />
  );
}

function EmptyRemoteEnvironments({ cloudEnabled = true }: { readonly cloudEnabled?: boolean }) {
  const gt = useGT();
  return (
    <Empty className="min-h-52">
      <EmptyMedia variant="icon">
        <ChevronsLeftRightEllipsisIcon />
      </EmptyMedia>
      <EmptyHeader>
        <EmptyTitle>
          <T>No saved remote environments</T>
        </EmptyTitle>
        <EmptyDescription>
          {cloudEnabled
            ? gt(
                "Click “Add environment” to pair another environment, or connect one from T3 Connect.",
              )
            : gt("Click “Add environment” to pair another environment.")}
        </EmptyDescription>
      </EmptyHeader>
    </Empty>
  );
}

export function CloudRemoteEnvironmentRows({
  primaryEnvironmentId,
  savedEnvironments,
  only,
}: {
  readonly primaryEnvironmentId: EnvironmentId | null;
  readonly savedEnvironments: ReadonlyArray<EnvironmentPresentation>;
  readonly only?: EnvironmentId;
}) {
  if (only !== undefined) {
    return (
      <CloudEnvironmentConnectRows
        only={only}
        primaryEnvironmentId={primaryEnvironmentId}
        savedEnvironments={savedEnvironments}
      />
    );
  }
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

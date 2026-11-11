import { useAtomValue } from "@effect/atom-react";
import { Link } from "@tanstack/react-router";
import type { EnvironmentConnectionPresentation } from "@t3tools/client-runtime/connection";
import {
  type GatewayScope,
  type GatewayStatusSnapshot,
  relayGrantsProblem,
} from "@t3tools/client-runtime/gateway";
import {
  EnvironmentId,
  type McpGatewayRelayPreview,
  MCP_GATEWAY_RELAY_GRANTS_MAX,
  WS_METHODS,
} from "@t3tools/contracts";
import { createEnvironmentRpcQueryAtomFamily } from "@t3tools/client-runtime/state/runtime";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import * as Atom from "effect/reactivity/Atom";
import { ChevronDownIcon } from "lucide-react";
import { useState, useSyncExternalStore } from "react";

import { useEnvironments } from "../../state/environments";
import { connectionAtomRuntime } from "../../connection/runtime";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { Input } from "../ui/input";
import { Textarea } from "../ui/textarea";
import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import { buildMcpGatewayHostConfig } from "../../mcpGatewayLaunchConfig";
import {
  Menu,
  MenuCheckboxItem,
  MenuGroup,
  MenuGroupLabel,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuTrigger,
} from "../ui/menu";
import { Switch } from "../ui/switch";
import { SettingsRow } from "./settingsLayout";
import {
  getMcpGatewayConfiguration,
  getMcpGatewayPort,
  setMcpGatewayPort,
  getMcpGatewayStatus,
  getMcpGatewayStatusSnapshot,
  MCP_GATEWAY_BASELINE_SCOPES,
  MCP_GATEWAY_CONFIGURABLE_SCOPES,
  publishMcpGatewayStatus,
  subscribeMcpGatewayStatus,
  subscribeMcpGatewayStatusSnapshot,
  requestMcpGatewayStatusSnapshot,
  type McpGatewayGrants,
  type McpGatewayUiState,
  setMcpGatewayEnabled,
  setMcpGatewayGrants,
  setMcpGatewayToken,
  subscribeMcpGatewayConfiguration,
} from "../../mcpGatewayState";

/**
 * Least-privilege scopes applied by the machine-level `On` baseline. The
 * per-machine menu exposes the full v3 contract separately so additional
 * authority is never granted implicitly.
 */
const SCOPE_LABELS: Record<GatewayScope, string> = {
  read: "Read environments and threads",
  create: "Create threads",
  send: "Send messages",
  control: "Control active work",
  lifecycle: "Pause, retry, and restart work",
  approval: "Review and decide approvals",
  artifact: "Retrieve thread artifacts",
  review: "Read and update code reviews",
  admin: "Change repositories and access",
  delivery: "Manage subscriptions and webhooks",
};

const ADVANCED_SCOPES = MCP_GATEWAY_CONFIGURABLE_SCOPES.filter(
  (scope) => !MCP_GATEWAY_BASELINE_SCOPES.includes(scope),
);

/** The scopes a server would still honor for this app on an environment, and why no more. */
export interface McpGrantCeiling {
  readonly scopes: ReadonlyArray<GatewayScope>;
  readonly reason: string;
}

export interface McpGrantEnvironmentRow {
  readonly environmentId: string;
  readonly label: string;
  readonly connectionState: string;
  readonly failureReason?: EnvironmentConnectionPresentation["failureReason"];
  readonly ceiling?: McpGrantCeiling | undefined;
}

/**
 * What servers would relay for this app on each environment, from their own answers: a scope is
 * open where any other server would honor it, and the reason is a server's own.
 */
export function mcpGrantCeilings(
  previews: ReadonlyArray<{ readonly serverId: string; readonly preview: McpGatewayRelayPreview }>,
  environmentIds: ReadonlyArray<string>,
): Record<string, McpGrantCeiling | undefined> {
  return Object.fromEntries(
    environmentIds.map((environmentId) => {
      const others = previews.filter(({ serverId }) => serverId !== environmentId);
      const scopes = [
        ...new Set(others.flatMap(({ preview }) => preview.grants[environmentId] ?? [])),
      ];
      if (others.length === 0 || MCP_GATEWAY_CONFIGURABLE_SCOPES.every((s) => scopes.includes(s))) {
        return [environmentId, undefined];
      }
      const reason =
        others.map(({ preview }) => preview.refusals[environmentId]).find((r) => r !== undefined) ??
        others.map(({ preview }) => preview.limit).find((r) => r !== undefined) ??
        "No connected server relays more here through this app.";
      return [environmentId, { scopes, reason }];
    }),
  );
}

const relayPreview = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "mcp-gateway:relay-preview",
  tag: WS_METHODS.mcpGatewayPreview,
  staleTimeMs: 10_000,
});

const grantCeilingsAtom = Atom.family((key: string) =>
  Atom.make((get) => {
    const { servers, environments } = JSON.parse(key) as {
      readonly servers: ReadonlyArray<string>;
      readonly environments: ReadonlyArray<string>;
    };
    const grants = Object.fromEntries(
      environments
        .slice(0, MCP_GATEWAY_RELAY_GRANTS_MAX)
        .map((environmentId) => [environmentId, MCP_GATEWAY_CONFIGURABLE_SCOPES]),
    );
    // A server too old to answer is left out; it still checks each call itself.
    const previews = servers.flatMap((serverId) => {
      const answer = AsyncResult.getOrElse(
        get(relayPreview({ environmentId: EnvironmentId.make(serverId), input: { grants } })),
        () => null,
      );
      return answer === null ? [] : [{ serverId, preview: answer }];
    });
    return mcpGrantCeilings(previews, environments);
  }),
);

function deviceConnectionText(environment: McpGrantEnvironmentRow): string {
  if (environment.connectionState === "connected") return "Connected";
  // Typed failure categories avoid copying tokens, URLs, or raw decoder payloads into Settings.
  const failure = (() => {
    switch (environment.failureReason) {
      case "authentication":
        return "Authentication failed: reconnect or sign in in Settings → Connections.";
      case "permission":
        return "Connection permission denied: review access in Settings → Connections.";
      case "unsupported":
        return "Incompatible connection: check client and server compatibility in Settings → Connections.";
      case "configuration":
        return "Connection configuration failed: review Settings → Connections.";
      case "transport":
        return "Transport failed: check the remote server and connection route.";
      case "timeout":
        return "Connection timed out: check the remote server and connection route.";
      case "network":
        return "Network unavailable: check network connectivity.";
      case "endpoint-unavailable":
      case "remote-unavailable":
        return "Remote unavailable: check the remote server and connection route.";
      default:
        return null;
    }
  })();
  const phase = (() => {
    switch (environment.connectionState) {
      case "connecting":
        return "Connecting";
      case "reconnecting":
        return "Reconnecting";
      case "offline":
        return "Disconnected: device or network offline";
      case "available":
        return "Disconnected: connect in Settings → Connections";
      case "error":
        return "Connection failed: see Settings → Connections";
      default:
        return "Unavailable: no current runtime connection";
    }
  })();
  return failure ? `${phase}. ${failure}` : phase;
}

function scopesFor(grants: McpGatewayGrants, environmentId: string): ReadonlyArray<GatewayScope> {
  return grants[environmentId] ?? [];
}

function isGrantOn(grants: McpGatewayGrants, environmentId: string): boolean {
  return (grants[environmentId] ?? []).length > 0;
}

function setEnvironmentScopes(
  grants: McpGatewayGrants,
  environmentId: string,
  scopes: ReadonlyArray<GatewayScope>,
): McpGatewayGrants {
  const next = { ...grants };
  if (scopes.length === 0) delete next[environmentId];
  else next[environmentId] = [...scopes];
  return next;
}

export function toggleMcpGatewayGrantForAll(
  grants: McpGatewayGrants,
  environments: ReadonlyArray<McpGrantEnvironmentRow>,
): McpGatewayGrants {
  const next = { ...grants };
  const allOn =
    environments.length > 0 &&
    environments.every((environment) => isGrantOn(grants, environment.environmentId));
  for (const environment of environments) {
    if (allOn) delete next[environment.environmentId];
    else if (!isGrantOn(grants, environment.environmentId)) {
      next[environment.environmentId] = [...MCP_GATEWAY_BASELINE_SCOPES];
    }
  }
  return next;
}

export function updateMcpGatewayGrant(
  grants: McpGatewayGrants,
  environmentId: string,
  scope: GatewayScope,
  checked: boolean,
): McpGatewayGrants {
  const current = grants[environmentId] ?? [];
  const nextScopes = checked
    ? [...new Set([...current, scope])]
    : current.filter((candidate) => candidate !== scope);
  return setEnvironmentScopes(grants, environmentId, nextScopes);
}

// Keep grant edits in the pending form until Save; enabling a machine grants only the baseline.
export function McpEnvironmentGrantMatrix({
  environments,
  grants,
  onChange,
  registryReady = true,
}: {
  readonly registryReady?: boolean;
  readonly environments: ReadonlyArray<McpGrantEnvironmentRow>;
  readonly grants: McpGatewayGrants;
  readonly onChange: (grants: McpGatewayGrants) => void;
}) {
  const registeredIds = new Set(environments.map((environment) => environment.environmentId));
  const visibleEnvironments = [
    ...environments,
    ...Object.keys(grants)
      .filter((environmentId) => !registeredIds.has(environmentId))
      .sort()
      .map((environmentId): McpGrantEnvironmentRow => ({
        environmentId,
        label: "Unavailable environment",
        connectionState: "unavailable",
      })),
  ];

  if (!registryReady) {
    return (
      <p className="text-sm text-muted-foreground">
        Device connection status unavailable: loading the runtime registry.
      </p>
    );
  }

  if (visibleEnvironments.length === 0) {
    return <p className="text-sm text-muted-foreground">No registered environments.</p>;
  }

  const allOn = visibleEnvironments.every((environment) =>
    isGrantOn(grants, environment.environmentId),
  );
  const anyOn = visibleEnvironments.some((environment) =>
    isGrantOn(grants, environment.environmentId),
  );

  const selectAll = () => onChange(toggleMcpGatewayGrantForAll(grants, visibleEnvironments));

  return (
    <div className="space-y-3">
      <p className="text-sm" aria-live="polite">
        {environments.filter((environment) => environment.connectionState === "connected").length}{" "}
        of {environments.length} registered devices connected. Access grants do not connect devices.
      </p>
      <div className="flex items-center justify-between gap-3">
        <label className="flex items-center gap-2 text-sm">
          <Checkbox
            checked={allOn}
            indeterminate={!allOn && anyOn}
            aria-label="Enable all environments"
            onCheckedChange={selectAll}
          />
          Enable all environments
        </label>
        <span className="text-xs text-muted-foreground">
          {allOn
            ? "Access on for all listed machines"
            : anyOn
              ? "Mixed selection of access grants"
              : "Access off for all listed machines"}
        </span>
      </div>
      {visibleEnvironments.map((environment) => {
        const on = isGrantOn(grants, environment.environmentId);
        const scopes = scopesFor(grants, environment.environmentId);
        const ceiling = environment.ceiling;
        const refused = (scope: GatewayScope) =>
          ceiling !== undefined && !ceiling.scopes.includes(scope);
        return (
          <div key={environment.environmentId} className="rounded-lg border p-3">
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <div className="font-medium">{environment.label}</div>
                <div className="text-xs" aria-live="polite">
                  {deviceConnectionText(environment)}
                </div>
                <div className="break-all font-mono text-xs text-muted-foreground">
                  {environment.environmentId}
                </div>
              </div>
              <Menu>
                <MenuTrigger
                  render={
                    <Button
                      variant="outline"
                      size="sm"
                      aria-label={`Access for ${environment.label}`}
                    />
                  }
                >
                  <span className="min-w-0 truncate">{on ? "Access on" : "Access off"}</span>
                  <ChevronDownIcon className="size-3 shrink-0 opacity-50" />
                </MenuTrigger>
                <MenuPopup align="end" className="w-56">
                  <MenuRadioGroup
                    value={
                      MCP_GATEWAY_CONFIGURABLE_SCOPES.every((scope) => scopes.includes(scope))
                        ? "all"
                        : on
                          ? "on"
                          : "off"
                    }
                    onValueChange={(value) => {
                      onChange(
                        setEnvironmentScopes(
                          grants,
                          environment.environmentId,
                          value === "all"
                            ? MCP_GATEWAY_CONFIGURABLE_SCOPES
                            : value === "on"
                              ? MCP_GATEWAY_BASELINE_SCOPES
                              : [],
                        ),
                      );
                    }}
                  >
                    <MenuRadioItem value="off">Off</MenuRadioItem>
                    <MenuRadioItem value="on" disabled={MCP_GATEWAY_BASELINE_SCOPES.some(refused)}>
                      On (default access)
                    </MenuRadioItem>
                    <MenuRadioItem
                      value="all"
                      disabled={MCP_GATEWAY_CONFIGURABLE_SCOPES.some(refused)}
                    >
                      All capabilities
                    </MenuRadioItem>
                  </MenuRadioGroup>
                  <MenuSeparator />
                  <MenuGroup>
                    <MenuGroupLabel>Default capabilities</MenuGroupLabel>
                    {MCP_GATEWAY_BASELINE_SCOPES.map((scope: GatewayScope) => (
                      <MenuCheckboxItem
                        key={scope}
                        checked={scopes.includes(scope)}
                        disabled={refused(scope) && !scopes.includes(scope)}
                        onCheckedChange={(checked) => {
                          onChange(
                            updateMcpGatewayGrant(
                              grants,
                              environment.environmentId,
                              scope,
                              checked,
                            ),
                          );
                        }}
                      >
                        {SCOPE_LABELS[scope] ?? scope}
                      </MenuCheckboxItem>
                    ))}
                  </MenuGroup>
                  <MenuSeparator />
                  <MenuGroup>
                    <MenuGroupLabel>Additional capabilities (grant explicitly)</MenuGroupLabel>
                    {ADVANCED_SCOPES.map((scope: GatewayScope) => (
                      <MenuCheckboxItem
                        key={scope}
                        checked={scopes.includes(scope)}
                        disabled={refused(scope) && !scopes.includes(scope)}
                        onCheckedChange={(checked) => {
                          onChange(
                            updateMcpGatewayGrant(
                              grants,
                              environment.environmentId,
                              scope,
                              checked,
                            ),
                          );
                        }}
                      >
                        {SCOPE_LABELS[scope]}
                      </MenuCheckboxItem>
                    ))}
                  </MenuGroup>
                </MenuPopup>
              </Menu>
            </div>
            {scopes.length > 0 ? (
              <div className="mt-2 text-xs text-muted-foreground">
                {scopes.map((scope) => SCOPE_LABELS[scope] ?? scope).join(", ")}
              </div>
            ) : null}
            {ceiling !== undefined ? (
              <div className="mt-1 text-xs text-muted-foreground">{ceiling.reason}</div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

export function McpGatewayOperationalStatus({
  state,
  snapshot,
  labels = {},
  environments = [],
  grants = {},
  onRefresh,
}: {
  readonly state: McpGatewayUiState;
  readonly snapshot: GatewayStatusSnapshot | null;
  readonly labels?: Readonly<Record<string, string>>;
  readonly environments?: ReadonlyArray<McpGrantEnvironmentRow>;
  readonly grants?: McpGatewayGrants;
  readonly onRefresh: () => void;
}) {
  const disconnected = state === "disabled" || state === "degraded";
  const readableEnvironments =
    snapshot?.environments.filter((environment) =>
      scopesFor(grants, environment.environmentId).includes("read"),
    ) ?? [];
  return (
    <div className="space-y-3" aria-label="MCP gateway operational status">
      <div className="flex items-center justify-between gap-3">
        <div className="text-sm font-medium">Operational status</div>
        <Button size="sm" variant="outline" onClick={onRefresh} disabled={state !== "running"}>
          Refresh
        </Button>
      </div>
      <p className="text-sm" aria-live="polite">
        Local gateway bridge:{" "}
        {state === "running"
          ? "Connected"
          : state === "connecting"
            ? "Connecting"
            : state === "disabled"
              ? "Disabled"
              : "Disconnected"}
        . This does not indicate device connectivity.
      </p>
      {disconnected ? (
        <p className="text-sm text-muted-foreground">
          {state === "disabled" ? "Gateway disabled." : "Gateway disconnected or degraded."}
        </p>
      ) : snapshot === null || state === "connecting" ? (
        <p className="text-sm text-muted-foreground">Loading operational status…</p>
      ) : !snapshot.live || snapshot.stale ? (
        <p className="text-sm text-destructive">
          Status is stale; live sidecar data is unavailable.
        </p>
      ) : readableEnvironments.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No readable environments are currently granted.
        </p>
      ) : (
        <>
          <p className="text-xs text-muted-foreground">
            Event store as of {snapshot.capturedAt}; this does not indicate device connectivity.
            Retention: {snapshot.retention.maxEventsPerEnvironment} events per environment for{" "}
            {snapshot.retention.maxAgeDays} days.
          </p>
          {readableEnvironments.map((environment) => (
            <div key={environment.environmentId} className="rounded-lg border p-3 text-sm">
              <div className="font-medium">
                {labels[environment.environmentId] ?? "Environment"}
              </div>
              <div className="break-all font-mono text-xs text-muted-foreground">
                {environment.environmentId}
              </div>
              <div className="mt-2 text-xs">
                Device:{" "}
                {deviceConnectionText(
                  environments.find((row) => row.environmentId === environment.environmentId) ?? {
                    environmentId: environment.environmentId,
                    label: "Environment",
                    connectionState: "unavailable",
                  },
                )}
              </div>
              <div className="mt-2 text-xs">
                Cursor {environment.latestSequence}; retained {environment.retainedEventCount};
                oldest {environment.oldestRetainedSequence ?? "none"}
              </div>
              {!environment.deliveryAccess ||
              !scopesFor(grants, environment.environmentId).includes("delivery") ? (
                <div className="mt-2 text-xs text-muted-foreground">
                  Delivery permission needed to view subscriptions, webhooks, and queue health.
                </div>
              ) : (
                <div className="mt-2 space-y-2 text-xs">
                  <div>
                    Delivery queue: {environment.deliveries?.pending ?? 0} pending,{" "}
                    {environment.deliveries?.inFlight ?? 0} in flight,{" "}
                    {environment.deliveries?.acked ?? 0} acknowledged,{" "}
                    {environment.deliveries?.failed ?? 0} failed;{" "}
                    {environment.deliveryFailureCount ?? 0} recorded failures.
                  </div>
                  <div>
                    Subscriptions ({environment.subscriptionCount ?? 0})
                    {environment.subscriptionsTruncated ? " (first 100 shown)" : ""}
                  </div>
                  {(environment.subscriptions ?? []).length === 0 ? (
                    <div className="text-muted-foreground">No subscriptions.</div>
                  ) : (
                    (environment.subscriptions ?? []).map((subscription) => (
                      <div
                        key={subscription.subscriptionId}
                        className="rounded border px-2 py-1 font-mono"
                      >
                        {subscription.subscriptionId}: {subscription.status}; cursor{" "}
                        {subscription.ackedSequence}; {subscription.pendingEventCount} pending
                      </div>
                    ))
                  )}
                  <div>
                    Webhooks ({environment.webhookCount ?? 0})
                    {environment.webhooksTruncated ? " (first 100 shown)" : ""}
                  </div>
                  {(environment.webhooks ?? []).length === 0 ? (
                    <div className="text-muted-foreground">No webhooks.</div>
                  ) : (
                    (environment.webhooks ?? []).map((webhook) => (
                      <div key={webhook.webhookId} className="rounded border px-2 py-1 font-mono">
                        {webhook.webhookId}: {webhook.status}; cursor {webhook.ackedSequence};{" "}
                        {webhook.deliveries.pending} pending, {webhook.deliveries.failed} failed
                      </div>
                    ))
                  )}
                </div>
              )}
            </div>
          ))}
        </>
      )}
    </div>
  );
}

/** The gateway's rows; Environments shows them in a fold. */
export function McpGatewaySettings() {
  const { environments, isReady: registryReady } = useEnvironments();
  const configuration = useSyncExternalStore(
    subscribeMcpGatewayConfiguration,
    getMcpGatewayConfiguration,
  );
  const { enabled, grants: savedGrants, token: savedToken, port: savedPort } = configuration;
  const [configurationError, setConfigurationError] = useState<string | null>(null);
  const [tokenDraft, setTokenDraft] = useState<{
    source: typeof configuration;
    value: string;
  } | null>(null);
  const token = tokenDraft?.source === configuration ? tokenDraft.value : savedToken;
  const [portDraft, setPortDraft] = useState<{
    source: typeof configuration;
    value: string;
  } | null>(null);
  const bridgePort = portDraft?.source === configuration ? portDraft.value : String(savedPort);
  const [grantsDraft, setGrantsDraft] = useState<{
    source: McpGatewayGrants;
    value: McpGatewayGrants;
  } | null>(null);
  // A changed source invalidates unsaved grants so a draft cannot restore another window's revocation.
  const pendingGrants = grantsDraft?.source === savedGrants ? grantsDraft.value : null;
  const gatewayStatus = useSyncExternalStore(subscribeMcpGatewayStatus, getMcpGatewayStatus);
  const status = enabled ? gatewayStatus : "disabled";
  const statusSnapshot = useSyncExternalStore(
    subscribeMcpGatewayStatusSnapshot,
    getMcpGatewayStatusSnapshot,
  );
  const [launch] = useState(() => window.desktopBridge?.getMcpGatewayLaunchConfig?.() ?? null);
  const [failedCopy, setFailedCopy] = useState<string | null>(null);
  const { copyToClipboard, isCopied } = useCopyToClipboard<string>({
    target: "MCP gateway configuration",
    onCopy: () => setFailedCopy(null),
    onError: (_error, value) => setFailedCopy(value),
  });
  const copyConfig = (format: "standard" | "opencode") => {
    if (launch === null) return;
    const value = JSON.stringify(
      buildMcpGatewayHostConfig(launch, token, getMcpGatewayPort())[format],
      null,
      2,
    );
    copyToClipboard(value, value);
  };

  const grantsProblem = relayGrantsProblem(pendingGrants ?? savedGrants);
  const grantsDirty =
    pendingGrants !== null && JSON.stringify(pendingGrants) !== JSON.stringify(savedGrants);

  const ceilings = useAtomValue(
    grantCeilingsAtom(
      JSON.stringify({
        servers: environments
          .filter((environment) => environment.connection.phase === "connected")
          .map((environment) => environment.environmentId),
        environments: environments.map((environment) => environment.environmentId),
      }),
    ),
  );
  const environmentRows: ReadonlyArray<McpGrantEnvironmentRow> = environments.map(
    (environment) => ({
      environmentId: environment.environmentId,
      label: environment.label,
      connectionState: environment.connection.phase,
      failureReason: environment.connection.failureReason,
      ceiling: ceilings[environment.environmentId],
    }),
  );

  return (
    <>
      {configurationError && <p role="alert">{configurationError}</p>}
      <SettingsRow
        id="enable-mcp-gateway"
        title="Enable MCP Gateway"
        description="Start the desktop gateway and make it available to new T3-managed agent sessions on granted local and remote environments. Restart existing agent sessions to attach the gateway."
        status={`Status: ${status}`}
        control={
          <Switch
            checked={enabled}
            aria-label="Enable MCP Gateway"
            onCheckedChange={(checked) => {
              const next = Boolean(checked);
              try {
                setMcpGatewayToken(token);
                setMcpGatewayEnabled(next);
                publishMcpGatewayStatus(next ? "connecting" : "disabled");
                setConfigurationError(null);
              } catch {
                setConfigurationError(
                  "Gateway settings could not be saved. Check browser storage access and try again.",
                );
              }
            }}
          />
        }
      />
      <SettingsRow
        id="mcp-gateway-port"
        title="Bridge port"
        description="Use the companion's T3_MCP_BRIDGE_PORT, or leave the default 47631. Connections stay on this computer."
        control={
          <Input
            aria-label="MCP gateway bridge port"
            type="number"
            min={1}
            max={65535}
            value={bridgePort}
            onChange={(event) => setPortDraft({ source: configuration, value: event.target.value })}
            onBlur={() => {
              try {
                setMcpGatewayPort(Number(bridgePort));
                setConfigurationError(null);
              } catch {
                setPortDraft(null);
                setConfigurationError(
                  "Choose a port from 1 to 65535 and ensure browser storage is available.",
                );
              }
            }}
          />
        }
      />
      <SettingsRow
        id="mcp-gateway-bridge-token"
        title="Bridge token"
        description="Set this to the same T3_MCP_BRIDGE_TOKEN configured in the MCP host. It is kept only for this browser session."
        control={
          <Input
            value={token}
            type="password"
            autoComplete="off"
            placeholder="At least 16 characters"
            aria-label="MCP gateway bridge token"
            onChange={(event) =>
              setTokenDraft({ source: configuration, value: event.target.value })
            }
            onBlur={() => setMcpGatewayToken(token)}
          />
        }
      />
      <SettingsRow
        id="mcp-gateway-environment-grants"
        title="Environment grants"
        description="One access control per machine, off by default; tweak it in each machine's menu and save. Agents on a machine below full access in your device network can only read elsewhere."
        status={
          grantsDirty
            ? "Unsaved changes"
            : `${Object.keys(savedGrants).length} machine${Object.keys(savedGrants).length === 1 ? "" : "s"} with access grants`
        }
        control={
          grantsDirty ? (
            <div className="flex items-center gap-2">
              <Button
                size="sm"
                onClick={() => {
                  try {
                    setMcpGatewayGrants(pendingGrants);
                    setGrantsDraft(null);
                    setConfigurationError(null);
                  } catch {
                    setConfigurationError(
                      "Could not save gateway permissions. Your changes have not been applied.",
                    );
                  }
                }}
              >
                Save
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  setGrantsDraft(null);
                }}
              >
                Cancel
              </Button>
            </div>
          ) : undefined
        }
      >
        {grantsProblem !== undefined ? (
          <p role="alert" className="mb-3 text-sm text-destructive">
            {grantsProblem}
          </p>
        ) : null}
        <McpEnvironmentGrantMatrix
          environments={environmentRows}
          registryReady={registryReady}
          grants={pendingGrants ?? savedGrants}
          onChange={(value) => setGrantsDraft({ source: savedGrants, value })}
        />
      </SettingsRow>
      <SettingsRow
        id="mcp-gateway-operational-status"
        title="Events and delivery"
        description="Live event retention, cursors, subscriptions, webhooks, and delivery queue health from the authenticated local companion."
      >
        <McpGatewayOperationalStatus
          state={status}
          snapshot={statusSnapshot}
          environments={environmentRows}
          grants={savedGrants}
          labels={Object.fromEntries(environmentRows.map((row) => [row.environmentId, row.label]))}
          onRefresh={() => {
            requestMcpGatewayStatusSnapshot();
          }}
        />
      </SettingsRow>
      <SettingsRow
        id="mcp-gateway-agents"
        title="Agents"
        description="MCP uses the shared Agents library for instructions, provider, model, and execution settings. Changes apply to new chats; existing chats keep their instructions."
        control={
          <Link to="/agents" className="text-sm underline underline-offset-4">
            Manage agents
          </Link>
        }
      />
      <SettingsRow
        title="External MCP hosts"
        description="Merge this into the MCP settings of assistants outside T3 Code on this computer, keeping existing servers, then reconnect. OpenCode uses ~/.config/opencode/opencode.jsonc. Includes your bridge token."
        status={
          launch === null
            ? "Available in the installed desktop app."
            : isCopied
              ? "Copied"
              : undefined
        }
        control={
          <div className="flex gap-2">
            <Button
              size="sm"
              variant="outline"
              disabled={launch === null || token.length < 16}
              onClick={() => copyConfig("opencode")}
            >
              Copy OpenCode config
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={launch === null || token.length < 16}
              onClick={() => copyConfig("standard")}
            >
              Copy MCP config
            </Button>
          </div>
        }
      >
        {failedCopy !== null ? (
          <Textarea readOnly aria-label="MCP configuration to copy manually" value={failedCopy} />
        ) : null}
      </SettingsRow>
      <SettingsRow
        title="Companion endpoint"
        description="The desktop starts the companion when enabled. Managed agents reach it through their T3 environment connection, including remote connections. External MCP hosts can use the configuration above."
        status={`ws://127.0.0.1:${getMcpGatewayPort()}`}
      />
    </>
  );
}

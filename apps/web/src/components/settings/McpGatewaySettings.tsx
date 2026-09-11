import { Link } from "@tanstack/react-router";
import type { EnvironmentConnectionPresentation } from "@t3tools/client-runtime/connection";
import { type GatewayScope, type GatewayStatusSnapshot } from "@t3tools/client-runtime/gateway";
import { ChevronDownIcon, ServerCogIcon } from "lucide-react";
import { useEffect, useState } from "react";

import { useEnvironments } from "../../state/environments";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { Input } from "../ui/input";
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
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";
import {
  getMcpGatewayGrants,
  getMcpGatewayPort,
  setMcpGatewayPort,
  getMcpGatewayStatus,
  getMcpGatewayStatusSnapshot,
  getMcpGatewayToken,
  isMcpGatewayEnabled,
  MCP_GATEWAY_BASELINE_SCOPES,
  MCP_GATEWAY_CONFIGURABLE_SCOPES,
  MCP_GATEWAY_STATE_EVENT,
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

export interface McpGrantEnvironmentRow {
  readonly environmentId: string;
  readonly label: string;
  readonly connectionState: string;
  readonly failureReason?: EnvironmentConnectionPresentation["failureReason"];
}

function deviceConnectionText(environment: McpGrantEnvironmentRow): string {
  if (environment.connectionState === "connected") return "Connected";
  // Typed failure categories avoid copying tokens, URLs, or raw decoder payloads into Settings.
  const failure = (() => {
    switch (environment.failureReason) {
      case "authentication":
        return "Authentication failed — reconnect or sign in in Settings → Connections.";
      case "permission":
        return "Connection permission denied — review access in Settings → Connections.";
      case "unsupported":
        return "Incompatible connection — check client and server compatibility in Settings → Connections.";
      case "configuration":
        return "Connection configuration failed — review Settings → Connections.";
      case "transport":
        return "Transport failed — check the remote server and connection route.";
      case "timeout":
        return "Connection timed out — check the remote server and connection route.";
      case "network":
        return "Network unavailable — check network connectivity.";
      case "relay-unavailable":
        return "Relay unavailable — check T3 Connect in Settings → Connections.";
      case "endpoint-unavailable":
      case "remote-unavailable":
        return "Remote unavailable — check the remote server and connection route.";
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
        return "Disconnected — device or network offline";
      case "available":
        return "Disconnected — connect in Settings → Connections";
      case "error":
        return "Connection failed — see Settings → Connections";
      default:
        return "Unavailable — no current runtime connection";
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

/**
 * Machine-first grant matrix (spec §9.2). One machine-level Off/On control
 * per row, a Select all action over the visible rows with indeterminate
 * mixed state, and a compact per-machine dropdown for the baseline plus
 * fine-grained scope tweaks. All edits stay in the caller's pending form
 * until Save.
 */
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
        Device connection status unavailable — loading the runtime registry.
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
                    <MenuRadioItem value="on">On (default access)</MenuRadioItem>
                    <MenuRadioItem value="all">All capabilities</MenuRadioItem>
                  </MenuRadioGroup>
                  <MenuSeparator />
                  <MenuGroup>
                    <MenuGroupLabel>Default capabilities</MenuGroupLabel>
                    {MCP_GATEWAY_BASELINE_SCOPES.map((scope: GatewayScope) => (
                      <MenuCheckboxItem
                        key={scope}
                        checked={scopes.includes(scope)}
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
                    {environment.subscriptionsTruncated ? " — first 100 shown" : ""}
                  </div>
                  {(environment.subscriptions ?? []).length === 0 ? (
                    <div className="text-muted-foreground">No subscriptions.</div>
                  ) : (
                    (environment.subscriptions ?? []).map((subscription) => (
                      <div
                        key={subscription.subscriptionId}
                        className="rounded border px-2 py-1 font-mono"
                      >
                        {subscription.subscriptionId} — {subscription.status}; cursor{" "}
                        {subscription.ackedSequence}; {subscription.pendingEventCount} pending
                      </div>
                    ))
                  )}
                  <div>
                    Webhooks ({environment.webhookCount ?? 0})
                    {environment.webhooksTruncated ? " — first 100 shown" : ""}
                  </div>
                  {(environment.webhooks ?? []).length === 0 ? (
                    <div className="text-muted-foreground">No webhooks.</div>
                  ) : (
                    (environment.webhooks ?? []).map((webhook) => (
                      <div key={webhook.webhookId} className="rounded border px-2 py-1 font-mono">
                        {webhook.webhookId} — {webhook.status}; cursor {webhook.ackedSequence};{" "}
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

export function McpGatewaySettings() {
  const { environments, isReady: registryReady } = useEnvironments();
  const [enabled, setEnabled] = useState(isMcpGatewayEnabled);
  const [configurationError, setConfigurationError] = useState<string | null>(null);
  const [token, setToken] = useState(getMcpGatewayToken);
  const [bridgePort, setBridgePort] = useState(() => String(getMcpGatewayPort()));
  const [savedGrants, setSavedGrants] = useState(getMcpGatewayGrants);
  const [pendingGrants, setPendingGrants] = useState<McpGatewayGrants | null>(null);
  const [status, setStatus] = useState<McpGatewayUiState>(() =>
    enabled ? getMcpGatewayStatus() : "disabled",
  );
  const [statusSnapshot, setStatusSnapshot] = useState(getMcpGatewayStatusSnapshot);

  useEffect(() => {
    const onStatus = (event: Event) => setStatus((event as CustomEvent<McpGatewayUiState>).detail);
    window.addEventListener(`${MCP_GATEWAY_STATE_EVENT}:status`, onStatus);
    return () => window.removeEventListener(`${MCP_GATEWAY_STATE_EVENT}:status`, onStatus);
  }, []);

  useEffect(() => {
    const onSnapshot = (event: Event) =>
      setStatusSnapshot((event as CustomEvent<GatewayStatusSnapshot | null>).detail);
    window.addEventListener(`${MCP_GATEWAY_STATE_EVENT}:snapshot`, onSnapshot);
    return () => window.removeEventListener(`${MCP_GATEWAY_STATE_EVENT}:snapshot`, onSnapshot);
  }, []);

  useEffect(() => {
    let saved = JSON.stringify(getMcpGatewayGrants());
    return subscribeMcpGatewayConfiguration(() => {
      setEnabled(isMcpGatewayEnabled());
      setToken(getMcpGatewayToken());
      setBridgePort(String(getMcpGatewayPort()));
      const next = getMcpGatewayGrants();
      const serialized = JSON.stringify(next);
      if (serialized !== saved) {
        saved = serialized;
        setSavedGrants(next);
        // Discard a stale draft so saving cannot restore another window's revoked grants.
        setPendingGrants(null);
      }
    });
  }, []);

  const grantsDirty =
    pendingGrants !== null && JSON.stringify(pendingGrants) !== JSON.stringify(savedGrants);

  const environmentRows: ReadonlyArray<McpGrantEnvironmentRow> = environments.map(
    (environment) => ({
      environmentId: environment.environmentId,
      label: environment.label,
      connectionState: environment.connection.phase,
      failureReason: environment.connection.failureReason,
    }),
  );

  return (
    <SettingsPageContainer>
      <SettingsSection title="MCP Gateway" icon={<ServerCogIcon className="size-5" />}>
        {configurationError && <p role="alert">{configurationError}</p>}
        <SettingsRow
          id="enable-mcp-gateway"
          title="Enable MCP Gateway"
          description="Connect this client runtime to the local T3 MCP companion. Disabled by default; when disabled no gateway socket or session is created."
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
                  setEnabled(next);
                  setStatus(next ? "connecting" : "disabled");
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
              onChange={(event) => setBridgePort(event.target.value)}
              onBlur={() => {
                try {
                  setMcpGatewayPort(Number(bridgePort));
                  setConfigurationError(null);
                } catch {
                  setBridgePort(String(getMcpGatewayPort()));
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
              onChange={(event) => setToken(event.target.value)}
              onBlur={() => {
                try {
                  setMcpGatewayToken(token);
                  setConfigurationError(null);
                } catch {
                  setToken(getMcpGatewayToken());
                  setConfigurationError(
                    "Gateway settings could not be saved. Check browser storage access and try again.",
                  );
                }
              }}
            />
          }
        />
        <SettingsRow
          id="mcp-gateway-environment-grants"
          title="Environment grants"
          description="One access control per machine: off by default, or on with the baseline capabilities. Fine-grained tweaks live in each machine's menu. Changes apply when you save."
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
                    setMcpGatewayGrants(pendingGrants);
                    setSavedGrants(pendingGrants);
                    setPendingGrants(null);
                  }}
                >
                  Save
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    setPendingGrants(null);
                  }}
                >
                  Cancel
                </Button>
              </div>
            ) : undefined
          }
        >
          <McpEnvironmentGrantMatrix
            environments={environmentRows}
            registryReady={registryReady}
            grants={pendingGrants ?? savedGrants}
            onChange={setPendingGrants}
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
            labels={Object.fromEntries(
              environmentRows.map((row) => [row.environmentId, row.label]),
            )}
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
          title="Companion endpoint"
          description="Start t3-mcp-gateway in your MCP host with T3_MCP_BRIDGE_TOKEN. The companion listens only on loopback, rejects unauthenticated clients, and receives the persisted environment grants above after authentication."
          status={`ws://127.0.0.1:${getMcpGatewayPort()}`}
        />
      </SettingsSection>
    </SettingsPageContainer>
  );
}

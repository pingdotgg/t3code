import type { GatewayProfile, GatewayScope } from "@t3tools/client-runtime/gateway";
import { PROVIDER_DISPLAY_NAMES } from "@t3tools/contracts";
import { ServerCogIcon } from "lucide-react";
import { useEffect, useState } from "react";

import { useEnvironments } from "../../state/environments";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";
import {
  getMcpGatewayGrants,
  getMcpGatewayProfiles,
  getMcpGatewayStatus,
  getMcpGatewayToken,
  isMcpGatewayEnabled,
  MCP_GATEWAY_STATE_EVENT,
  type McpGatewayGrants,
  type McpGatewayUiState,
  setMcpGatewayEnabled,
  setMcpGatewayGrants,
  setMcpGatewayProfiles,
  setMcpGatewayToken,
} from "../../mcpGatewayState";

const ALL_GATEWAY_SCOPES = ["read", "create", "send"] as const;
type GrantPreset = "read" | "read-create" | "read-send" | "full";
const GRANT_PRESETS: Record<GrantPreset, { label: string; scopes: ReadonlyArray<GatewayScope> }> = {
  read: { label: "Read only", scopes: ["read"] },
  "read-create": { label: "Read and create", scopes: ["read", "create"] },
  "read-send": { label: "Read and send", scopes: ["read", "send"] },
  full: { label: "Read, create, and send", scopes: ALL_GATEWAY_SCOPES },
};

export function setMcpGatewayMachineEnabled(
  grants: McpGatewayGrants,
  environmentId: string,
  enabled: boolean,
): McpGatewayGrants {
  const next = { ...grants };
  if (enabled) next[environmentId] = ALL_GATEWAY_SCOPES;
  else delete next[environmentId];
  return next;
}

export function setMcpGatewayMachineGrantPreset(
  grants: McpGatewayGrants,
  environmentId: string,
  preset: GrantPreset,
): McpGatewayGrants {
  return { ...grants, [environmentId]: GRANT_PRESETS[preset].scopes };
}

export function selectAllMcpGatewayGrants(
  environments: ReadonlyArray<{ readonly environmentId: string }>,
): McpGatewayGrants {
  return Object.fromEntries(
    environments.map((environment) => [environment.environmentId, ALL_GATEWAY_SCOPES]),
  );
}

function presetForScopes(scopes: ReadonlyArray<GatewayScope>): GrantPreset {
  const key = [...scopes].sort().join(",");
  if (key === "create,read") return "read-create";
  if (key === "read,send") return "read-send";
  if (key === "create,read,send") return "full";
  return "read";
}

interface ProfileModel {
  readonly slug: string;
  readonly name: string;
  readonly shortName?: string | undefined;
}

interface ProfileProvider {
  readonly instanceId: string;
  readonly driver: string;
  readonly displayName?: string | undefined;
  readonly enabled: boolean;
  readonly installed: boolean;
  readonly status: string;
  readonly models: ReadonlyArray<ProfileModel>;
}

function profileProviderLabel(provider: Pick<ProfileProvider, "driver" | "displayName">): string {
  return (
    provider.displayName ??
    (PROVIDER_DISPLAY_NAMES as Readonly<Record<string, string>>)[provider.driver] ??
    provider.driver
  );
}

export function createMcpGatewayProfile(input: {
  readonly name: string;
  readonly environmentId: string;
  readonly provider: Pick<ProfileProvider, "instanceId" | "driver" | "displayName">;
  readonly model: ProfileModel;
  readonly reasoningEffort: NonNullable<GatewayProfile["reasoningEffort"]>;
  readonly runtimeMode: GatewayProfile["runtimeMode"];
}): GatewayProfile {
  return {
    name: input.name.trim(),
    environmentId: input.environmentId,
    providerLabel: profileProviderLabel(input.provider),
    modelLabel: input.model.shortName ?? input.model.name,
    instanceId: input.provider.instanceId,
    model: input.model.slug,
    reasoningEffort: input.reasoningEffort,
    runtimeMode: input.runtimeMode,
    interactionMode: "default",
  };
}

export function upsertMcpGatewayProfile(
  profiles: ReadonlyArray<GatewayProfile>,
  originalName: string | undefined,
  profile: GatewayProfile,
): ReadonlyArray<GatewayProfile> {
  if (originalName === undefined) return [...profiles, profile];
  return profiles.map((candidate) => (candidate.name === originalName ? profile : candidate));
}

const REASONING_OPTIONS = ["low", "medium", "high", "xhigh"] as const;
const RUNTIME_OPTIONS = [
  ["approval-required", "Supervised"],
  ["auto-accept-edits", "Auto-accept edits"],
  ["auto", "Auto"],
  ["full-access", "Full access"],
] as const;

function titleCase(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

export function McpGatewayProfileEditor({
  environments,
  profiles,
  onChange,
}: {
  readonly environments: ReadonlyArray<{
    readonly environmentId: string;
    readonly label: string;
    readonly providers: ReadonlyArray<ProfileProvider>;
  }>;
  readonly profiles: ReadonlyArray<GatewayProfile>;
  readonly onChange: (profiles: ReadonlyArray<GatewayProfile>) => void;
}) {
  const availableEnvironments = environments.filter((environment) =>
    environment.providers.some(
      (provider) =>
        provider.enabled &&
        provider.installed &&
        provider.status === "ready" &&
        provider.models.length > 0,
    ),
  );
  const [name, setName] = useState("");
  const [editingName, setEditingName] = useState<string>();
  const [environmentId, setEnvironmentId] = useState(availableEnvironments[0]?.environmentId ?? "");
  const environment =
    availableEnvironments.find((candidate) => candidate.environmentId === environmentId) ??
    availableEnvironments[0];
  const providers =
    environment?.providers.filter(
      (provider) =>
        provider.enabled &&
        provider.installed &&
        provider.status === "ready" &&
        provider.models.length > 0,
    ) ?? [];
  const [instanceId, setInstanceId] = useState(providers[0]?.instanceId ?? "");
  const provider =
    providers.find((candidate) => candidate.instanceId === instanceId) ?? providers[0];
  const [modelSlug, setModelSlug] = useState(provider?.models[0]?.slug ?? "");
  const model =
    provider?.models.find((candidate) => candidate.slug === modelSlug) ?? provider?.models[0];
  const [reasoningEffort, setReasoningEffort] =
    useState<NonNullable<GatewayProfile["reasoningEffort"]>>("medium");
  const [runtimeMode, setRuntimeMode] = useState<GatewayProfile["runtimeMode"]>("full-access");

  const selectEnvironment = (nextEnvironmentId: string) => {
    const nextEnvironment = availableEnvironments.find(
      (candidate) => candidate.environmentId === nextEnvironmentId,
    );
    const nextProvider = nextEnvironment?.providers.find(
      (candidate) =>
        candidate.enabled &&
        candidate.installed &&
        candidate.status === "ready" &&
        candidate.models.length > 0,
    );
    setEnvironmentId(nextEnvironmentId);
    setInstanceId(nextProvider?.instanceId ?? "");
    setModelSlug(nextProvider?.models[0]?.slug ?? "");
  };
  const selectProvider = (nextInstanceId: string) => {
    const nextProvider = providers.find((candidate) => candidate.instanceId === nextInstanceId);
    setInstanceId(nextInstanceId);
    setModelSlug(nextProvider?.models[0]?.slug ?? "");
  };
  const canAdd =
    name.trim() !== "" &&
    !profiles.some((profile) => profile.name === name.trim() && profile.name !== editingName) &&
    environment !== undefined &&
    provider !== undefined &&
    model !== undefined;

  const editProfile = (profile: GatewayProfile) => {
    setEditingName(profile.name);
    setName(profile.name);
    setEnvironmentId(profile.environmentId);
    setInstanceId(profile.instanceId);
    setModelSlug(profile.model);
    setReasoningEffort(profile.reasoningEffort ?? "medium");
    setRuntimeMode(profile.runtimeMode);
  };

  return (
    <div className="space-y-3">
      {profiles.map((profile) => (
        <div
          key={profile.name}
          className="flex items-center justify-between gap-3 rounded-lg border p-3"
        >
          <div className="min-w-0">
            <div className="font-medium">{profile.name}</div>
            <div className="truncate text-xs text-muted-foreground">
              {profile.providerLabel} · {profile.modelLabel} ·{" "}
              {titleCase(profile.reasoningEffort ?? "default")} ·{" "}
              {RUNTIME_OPTIONS.find(([value]) => value === profile.runtimeMode)?.[1] ??
                profile.runtimeMode}
            </div>
          </div>
          <div className="flex items-center gap-1">
            <Button
              variant="ghost"
              size="sm"
              aria-label={`Edit ${profile.name}`}
              onClick={() => editProfile(profile)}
            >
              Edit
            </Button>
            <Button
              variant="ghost"
              size="sm"
              aria-label={`Remove ${profile.name}`}
              onClick={() =>
                onChange(profiles.filter((candidate) => candidate.name !== profile.name))
              }
            >
              Remove
            </Button>
          </div>
        </div>
      ))}
      {availableEnvironments.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No connected machine has a ready provider and model.
        </p>
      ) : (
        <div className="grid gap-3 rounded-lg border p-3 sm:grid-cols-2">
          <Input
            value={name}
            placeholder="Profile name"
            aria-label="Profile name"
            onChange={(event) => setName(event.target.value)}
          />
          <Select
            value={environment?.environmentId ?? ""}
            onValueChange={(value) => selectEnvironment(String(value))}
          >
            <SelectTrigger aria-label="Profile machine">
              <SelectValue>{environment?.label}</SelectValue>
            </SelectTrigger>
            <SelectPopup>
              {availableEnvironments.map((candidate) => (
                <SelectItem key={candidate.environmentId} value={candidate.environmentId}>
                  {candidate.label}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
          <Select
            value={provider?.instanceId ?? ""}
            onValueChange={(value) => selectProvider(String(value))}
          >
            <SelectTrigger aria-label="Profile provider">
              <SelectValue>{provider ? profileProviderLabel(provider) : "Provider"}</SelectValue>
            </SelectTrigger>
            <SelectPopup>
              {providers.map((candidate) => (
                <SelectItem key={candidate.instanceId} value={candidate.instanceId}>
                  {profileProviderLabel(candidate)}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
          <Select value={model?.slug ?? ""} onValueChange={(value) => setModelSlug(String(value))}>
            <SelectTrigger aria-label="Profile model">
              <SelectValue>{model?.shortName ?? model?.name ?? "Model"}</SelectValue>
            </SelectTrigger>
            <SelectPopup>
              {provider?.models.map((candidate) => (
                <SelectItem key={candidate.slug} value={candidate.slug}>
                  {candidate.shortName ?? candidate.name}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
          <Select
            value={reasoningEffort}
            onValueChange={(value) => setReasoningEffort(value as typeof reasoningEffort)}
          >
            <SelectTrigger aria-label="Profile reasoning effort">
              <SelectValue>{titleCase(reasoningEffort)}</SelectValue>
            </SelectTrigger>
            <SelectPopup>
              {REASONING_OPTIONS.map((value) => (
                <SelectItem key={value} value={value}>
                  {titleCase(value)}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
          <Select
            value={runtimeMode}
            onValueChange={(value) => setRuntimeMode(value as GatewayProfile["runtimeMode"])}
          >
            <SelectTrigger aria-label="Profile runtime mode">
              <SelectValue>
                {RUNTIME_OPTIONS.find(([value]) => value === runtimeMode)?.[1]}
              </SelectValue>
            </SelectTrigger>
            <SelectPopup>
              {RUNTIME_OPTIONS.map(([value, label]) => (
                <SelectItem key={value} value={value}>
                  {label}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
          <Button
            disabled={!canAdd}
            onClick={() => {
              if (
                !canAdd ||
                environment === undefined ||
                provider === undefined ||
                model === undefined
              )
                return;
              onChange(
                upsertMcpGatewayProfile(
                  profiles,
                  editingName,
                  createMcpGatewayProfile({
                    name,
                    environmentId: environment.environmentId,
                    provider,
                    model,
                    reasoningEffort,
                    runtimeMode,
                  }),
                ),
              );
              setName("");
              setEditingName(undefined);
            }}
          >
            {editingName === undefined ? "Add profile" : "Save profile"}
          </Button>
        </div>
      )}
    </div>
  );
}

export function McpEnvironmentGrantMatrix({
  environments,
  grants,
  onChange,
}: {
  readonly environments: ReadonlyArray<{
    readonly environmentId: string;
    readonly label: string;
    readonly connectionState: string;
  }>;
  readonly grants: McpGatewayGrants;
  readonly onChange: (grants: McpGatewayGrants) => void;
}) {
  const registeredIds = new Set(environments.map((environment) => environment.environmentId));
  const visibleEnvironments = [
    ...environments.map((environment) => ({ ...environment, registered: true })),
    ...Object.keys(grants)
      .filter((environmentId) => !registeredIds.has(environmentId))
      .sort()
      .map((environmentId) => ({
        environmentId,
        label: "Unavailable machine",
        connectionState: "unavailable",
        registered: false,
      })),
  ];
  if (visibleEnvironments.length === 0) {
    return <p className="text-sm text-muted-foreground">No registered machines.</p>;
  }

  return (
    <div className="space-y-3">
      <div className="flex justify-end">
        <Button
          size="sm"
          variant="outline"
          onClick={() => onChange(selectAllMcpGatewayGrants(environments))}
        >
          Select all grants
        </Button>
      </div>
      {visibleEnvironments.map((environment) => (
        <div key={environment.environmentId} className="rounded-lg border p-3">
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="font-medium">{environment.label}</div>
              <div className="break-all font-mono text-xs text-muted-foreground">
                {environment.environmentId}
              </div>
            </div>
            <div className="flex items-center gap-3">
              <span className="text-xs text-muted-foreground">{environment.connectionState}</span>
              <Switch
                checked={grants[environment.environmentId] !== undefined}
                aria-label={`Enable MCP access for ${environment.label}`}
                onCheckedChange={(checked) =>
                  onChange(
                    setMcpGatewayMachineEnabled(
                      grants,
                      environment.environmentId,
                      Boolean(checked),
                    ),
                  )
                }
              />
            </div>
          </div>
          {grants[environment.environmentId] !== undefined ? (
            <div className="mt-3 flex justify-end">
              <Select
                value={presetForScopes(grants[environment.environmentId] ?? [])}
                onValueChange={(value) =>
                  onChange(
                    setMcpGatewayMachineGrantPreset(
                      grants,
                      environment.environmentId,
                      value as GrantPreset,
                    ),
                  )
                }
              >
                <SelectTrigger
                  size="sm"
                  className="w-56"
                  aria-label={`Choose grants for ${environment.label}`}
                >
                  <SelectValue>
                    {GRANT_PRESETS[presetForScopes(grants[environment.environmentId] ?? [])].label}
                  </SelectValue>
                </SelectTrigger>
                <SelectPopup align="end" alignItemWithTrigger={false}>
                  {(
                    Object.entries(GRANT_PRESETS) as Array<
                      [GrantPreset, (typeof GRANT_PRESETS)[GrantPreset]]
                    >
                  ).map(([value, option]) => (
                    <SelectItem key={value} value={value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            </div>
          ) : null}
        </div>
      ))}
    </div>
  );
}

export function McpGatewaySettings() {
  const { environments } = useEnvironments();
  const launchConfig = window.desktopBridge?.getMcpGatewayLaunchConfig() ?? null;
  const [enabled, setEnabled] = useState(isMcpGatewayEnabled);
  const [token, setToken] = useState(getMcpGatewayToken);
  const [grants, setGrants] = useState(getMcpGatewayGrants);
  const [profiles, setProfiles] = useState(getMcpGatewayProfiles);
  const [status, setStatus] = useState<McpGatewayUiState>(() =>
    enabled ? getMcpGatewayStatus() : "disabled",
  );

  useEffect(() => {
    const onStatus = (event: Event) => setStatus((event as CustomEvent<McpGatewayUiState>).detail);
    window.addEventListener(`${MCP_GATEWAY_STATE_EVENT}:status`, onStatus);
    return () => window.removeEventListener(`${MCP_GATEWAY_STATE_EVENT}:status`, onStatus);
  }, []);

  if (launchConfig === null) {
    return (
      <SettingsPageContainer>
        <SettingsSection title="MCP Gateway" icon={<ServerCogIcon className="size-5" />}>
          <SettingsRow
            title="Packaged desktop feature"
            description="The MCP gateway is available only in an installed production T3 Code desktop app."
            status="Unavailable in this build"
          />
        </SettingsSection>
      </SettingsPageContainer>
    );
  }

  return (
    <SettingsPageContainer>
      <SettingsSection title="MCP Gateway" icon={<ServerCogIcon className="size-5" />}>
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
                setEnabled(next);
                setStatus(next ? "connecting" : "disabled");
                setMcpGatewayToken(token);
                setMcpGatewayEnabled(next);
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
              onBlur={() => setMcpGatewayToken(token)}
            />
          }
        />
        <SettingsRow
          id="mcp-gateway-environment-grants"
          title="Machine grants"
          description="Allow selected machines and choose a readable access preset for each. Nothing is granted by default."
        >
          <McpEnvironmentGrantMatrix
            environments={environments.map((environment) => ({
              environmentId: environment.environmentId,
              label: environment.label,
              connectionState: environment.connection.phase,
            }))}
            grants={grants}
            onChange={(next) => {
              setGrants(next);
              setMcpGatewayGrants(next);
            }}
          />
        </SettingsRow>
        <SettingsRow
          id="mcp-gateway-profiles"
          title="Profiles"
          description="Name a machine, provider, model, reasoning effort, and permission mode. MCP clients see only the readable profile description."
        >
          <McpGatewayProfileEditor
            environments={environments
              .filter((environment) => grants[environment.environmentId]?.includes("create"))
              .map((environment) => ({
                environmentId: environment.environmentId,
                label: environment.label,
                providers: environment.serverConfig?.providers ?? [],
              }))}
            profiles={profiles}
            onChange={(next) => {
              setProfiles(next);
              setMcpGatewayProfiles(next);
            }}
          />
        </SettingsRow>
        <SettingsRow
          title="Companion endpoint"
          description="Paste this server entry into your MCP host configuration. The bundled companion runs with T3 Code's packaged runtime and listens only on loopback."
          status="ws://127.0.0.1:47631"
        >
          <pre className="overflow-x-auto rounded-lg border bg-muted/40 p-3 text-xs">
            {JSON.stringify(
              {
                command: launchConfig.command,
                args: launchConfig.args,
                env: { ...launchConfig.env, T3_MCP_BRIDGE_TOKEN: token },
              },
              null,
              2,
            )}
          </pre>
        </SettingsRow>
      </SettingsSection>
    </SettingsPageContainer>
  );
}

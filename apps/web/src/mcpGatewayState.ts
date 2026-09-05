import type { GatewayProfile, GatewayScope } from "@t3tools/client-runtime/gateway";

export const MCP_GATEWAY_ENABLED_KEY = "t3code:mcp-gateway-enabled";
export const MCP_GATEWAY_TOKEN_KEY = "t3code:mcp-gateway-bridge-token";
export const MCP_GATEWAY_GRANTS_KEY = "t3code:mcp-gateway-grants";
export const MCP_GATEWAY_PROFILES_KEY = "t3code:mcp-gateway-profiles";
export const MCP_GATEWAY_STATE_EVENT = "t3code:mcp-gateway-state";

export type McpGatewayGrants = Readonly<Record<string, ReadonlyArray<GatewayScope>>>;
export type McpGatewayUiState = "disabled" | "connecting" | "running" | "degraded";

const GATEWAY_SCOPES = new Set<GatewayScope>(["read", "create", "send"]);
const REASONING_EFFORTS = new Set(["low", "medium", "high", "xhigh"]);
const RUNTIME_MODES = new Set(["approval-required", "auto-accept-edits", "auto", "full-access"]);
let currentMcpGatewayStatus: McpGatewayUiState = "disabled";

export function isMcpGatewayEnabled(): boolean {
  try {
    return window.localStorage.getItem(MCP_GATEWAY_ENABLED_KEY) === "true";
  } catch {
    return false;
  }
}

export function getMcpGatewayToken(): string {
  try {
    return window.sessionStorage.getItem(MCP_GATEWAY_TOKEN_KEY) ?? "";
  } catch {
    return "";
  }
}

export function getMcpGatewayGrants(): McpGatewayGrants {
  try {
    const raw = window.localStorage.getItem(MCP_GATEWAY_GRANTS_KEY);
    if (raw === null) return {};
    const value = JSON.parse(raw) as unknown;
    if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
    const grants: Record<string, ReadonlyArray<GatewayScope>> = {};
    for (const [environmentId, candidate] of Object.entries(value)) {
      if (environmentId.trim() === "" || !Array.isArray(candidate)) continue;
      const scopes = [...new Set(candidate)].filter(
        (scope): scope is GatewayScope =>
          typeof scope === "string" && GATEWAY_SCOPES.has(scope as GatewayScope),
      );
      const isValid = candidate.every(
        (scope) => typeof scope === "string" && GATEWAY_SCOPES.has(scope as GatewayScope),
      );
      if (isValid && scopes.length > 0) grants[environmentId] = scopes;
    }
    return grants;
  } catch {
    return {};
  }
}

function isMcpGatewayProfile(value: unknown): value is GatewayProfile {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const profile = value as Record<string, unknown>;
  return (
    ["name", "environmentId", "providerLabel", "modelLabel", "instanceId", "model"].every(
      (key) => typeof profile[key] === "string" && (profile[key] as string).trim() !== "",
    ) &&
    (profile.reasoningEffort === undefined ||
      (typeof profile.reasoningEffort === "string" &&
        REASONING_EFFORTS.has(profile.reasoningEffort))) &&
    typeof profile.runtimeMode === "string" &&
    RUNTIME_MODES.has(profile.runtimeMode) &&
    (profile.interactionMode === "default" || profile.interactionMode === "plan")
  );
}

export function getMcpGatewayProfiles(): ReadonlyArray<GatewayProfile> {
  try {
    const value = JSON.parse(
      window.localStorage.getItem(MCP_GATEWAY_PROFILES_KEY) ?? "[]",
    ) as unknown;
    if (!Array.isArray(value)) return [];
    const names = new Set<string>();
    return value.filter((candidate): candidate is GatewayProfile => {
      if (!isMcpGatewayProfile(candidate) || names.has(candidate.name)) return false;
      names.add(candidate.name);
      return true;
    });
  } catch {
    return [];
  }
}

export function getMcpGatewayStatus(): McpGatewayUiState {
  return currentMcpGatewayStatus;
}

export function publishMcpGatewayStatus(status: McpGatewayUiState): void {
  currentMcpGatewayStatus = status;
  window.dispatchEvent(
    new CustomEvent<McpGatewayUiState>(`${MCP_GATEWAY_STATE_EVENT}:status`, { detail: status }),
  );
}

export function subscribeMcpGatewayConfiguration(onChange: () => void): () => void {
  const onStorage = (event: StorageEvent) => {
    if (
      event.key === null ||
      event.key === MCP_GATEWAY_ENABLED_KEY ||
      event.key === MCP_GATEWAY_GRANTS_KEY ||
      event.key === MCP_GATEWAY_PROFILES_KEY
    ) {
      onChange();
    }
  };
  window.addEventListener(MCP_GATEWAY_STATE_EVENT, onChange);
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener(MCP_GATEWAY_STATE_EVENT, onChange);
    window.removeEventListener("storage", onStorage);
  };
}

export function setMcpGatewayToken(token: string): void {
  window.sessionStorage.setItem(MCP_GATEWAY_TOKEN_KEY, token);
  window.dispatchEvent(new Event(MCP_GATEWAY_STATE_EVENT));
}

export function setMcpGatewayGrants(grants: McpGatewayGrants): void {
  window.localStorage.setItem(MCP_GATEWAY_GRANTS_KEY, JSON.stringify(grants));
  window.dispatchEvent(new Event(MCP_GATEWAY_STATE_EVENT));
}

export function setMcpGatewayProfiles(profiles: ReadonlyArray<GatewayProfile>): void {
  window.localStorage.setItem(MCP_GATEWAY_PROFILES_KEY, JSON.stringify(profiles));
  window.dispatchEvent(new Event(MCP_GATEWAY_STATE_EVENT));
}

export function setMcpGatewayEnabled(enabled: boolean): void {
  window.localStorage.setItem(MCP_GATEWAY_ENABLED_KEY, String(enabled));
  window.dispatchEvent(new Event(MCP_GATEWAY_STATE_EVENT));
}

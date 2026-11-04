import { GATEWAY_SCOPE_VALUES } from "@t3tools/client-runtime/gateway";
import type { GatewayScope, GatewayStatusSnapshot } from "@t3tools/client-runtime/gateway";

const MCP_GATEWAY_PORT_KEY = "t3code:mcp-gateway-port";
export const MCP_GATEWAY_ENABLED_KEY = "t3code:mcp-gateway-enabled";
export const MCP_GATEWAY_TOKEN_KEY = "t3code:mcp-gateway-bridge-token";
export const MCP_GATEWAY_GRANTS_KEY = "t3code:mcp-gateway-grants";
export const MCP_GATEWAY_STATE_EVENT = "t3code:mcp-gateway-state";

let gatewayStatusSnapshot: GatewayStatusSnapshot | null = null;
let requestGatewayStatus: (() => boolean) | null = null;

export function getMcpGatewayStatusSnapshot(): GatewayStatusSnapshot | null {
  return gatewayStatusSnapshot;
}

export function publishMcpGatewayStatusSnapshot(snapshot: GatewayStatusSnapshot | null): void {
  gatewayStatusSnapshot = snapshot;
  window.dispatchEvent(
    new CustomEvent<GatewayStatusSnapshot | null>(`${MCP_GATEWAY_STATE_EVENT}:snapshot`, {
      detail: snapshot,
    }),
  );
}

export function setMcpGatewayStatusRequester(requester: (() => boolean) | null): void {
  requestGatewayStatus = requester;
}

export function requestMcpGatewayStatusSnapshot(): boolean {
  return requestGatewayStatus?.() ?? false;
}

export type McpGatewayGrants = Readonly<Record<string, ReadonlyArray<GatewayScope>>>;
export type McpGatewayUiState = "disabled" | "connecting" | "running" | "degraded";

export const MCP_GATEWAY_BASELINE_SCOPES: ReadonlyArray<GatewayScope> = ["read", "create", "send"];
export const MCP_GATEWAY_CONFIGURABLE_SCOPES: ReadonlyArray<GatewayScope> = GATEWAY_SCOPE_VALUES;
const GATEWAY_SCOPES = new Set<GatewayScope>(MCP_GATEWAY_CONFIGURABLE_SCOPES);
let currentMcpGatewayStatus: McpGatewayUiState = "disabled";

export function getMcpGatewayStatus(): McpGatewayUiState {
  return currentMcpGatewayStatus;
}

function sanitizeMcpGatewayGrants(value: unknown): McpGatewayGrants {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  const grants: Record<string, ReadonlyArray<GatewayScope>> = {};
  for (const [environmentId, candidate] of Object.entries(value)) {
    if (environmentId.trim() === "" || !Array.isArray(candidate)) continue;
    const isValid = candidate.every(
      (scope) => typeof scope === "string" && GATEWAY_SCOPES.has(scope as GatewayScope),
    );
    if (!isValid) continue;
    const scopes = [...new Set(candidate)] as ReadonlyArray<GatewayScope>;
    if (scopes.length > 0) grants[environmentId] = scopes;
  }
  return grants;
}

export function getMcpGatewayPort(): number {
  const raw = window.localStorage.getItem(MCP_GATEWAY_PORT_KEY);
  const port = raw === null ? 47631 : Number(raw);
  return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : 47631;
}

export function setMcpGatewayPort(port: number): void {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid gateway port.");
  window.localStorage.setItem(MCP_GATEWAY_PORT_KEY, String(port));
  window.dispatchEvent(new Event(MCP_GATEWAY_STATE_EVENT));
}

export function isMcpGatewayEnabled(): boolean {
  return window.localStorage.getItem(MCP_GATEWAY_ENABLED_KEY) === "true";
}

export function getMcpGatewayToken(): string {
  const sessionToken = window.sessionStorage.getItem(MCP_GATEWAY_TOKEN_KEY);
  // Settings saves an empty field too; that must not hide the desktop's durable token.
  if (sessionToken !== null && sessionToken !== "") return sessionToken;
  return window.desktopBridge?.getMcpGatewayBridgeToken?.() ?? "";
}

let grantsSource: string | null | undefined;
let grantsSnapshot: McpGatewayGrants = {};

export function getMcpGatewayGrants(): McpGatewayGrants {
  const raw = window.localStorage.getItem(MCP_GATEWAY_GRANTS_KEY);
  if (raw === grantsSource) return grantsSnapshot;
  grantsSource = raw;
  try {
    grantsSnapshot = raw === null ? {} : sanitizeMcpGatewayGrants(JSON.parse(raw) as unknown);
  } catch {
    grantsSnapshot = {};
  }
  return grantsSnapshot;
}

type McpGatewayConfiguration = {
  readonly available: boolean;
  readonly enabled: boolean;
  readonly port: number;
  readonly token: string;
  readonly grants: McpGatewayGrants;
};
let configurationSnapshot: McpGatewayConfiguration | undefined;

export function getMcpGatewayConfiguration(): McpGatewayConfiguration {
  const next = {
    available: (window.desktopBridge?.getMcpGatewayLaunchConfig?.() ?? null) !== null,
    enabled: isMcpGatewayEnabled(),
    port: getMcpGatewayPort(),
    token: getMcpGatewayToken(),
    grants: getMcpGatewayGrants(),
  };
  if (
    !configurationSnapshot ||
    configurationSnapshot.available !== next.available ||
    configurationSnapshot.enabled !== next.enabled ||
    configurationSnapshot.port !== next.port ||
    configurationSnapshot.token !== next.token ||
    configurationSnapshot.grants !== next.grants
  )
    configurationSnapshot = next;
  return configurationSnapshot;
}

export function subscribeMcpGatewayStatus(onChange: () => void): () => void {
  window.addEventListener(`${MCP_GATEWAY_STATE_EVENT}:status`, onChange);
  return () => window.removeEventListener(`${MCP_GATEWAY_STATE_EVENT}:status`, onChange);
}

export function subscribeMcpGatewayStatusSnapshot(onChange: () => void): () => void {
  window.addEventListener(`${MCP_GATEWAY_STATE_EVENT}:snapshot`, onChange);
  return () => window.removeEventListener(`${MCP_GATEWAY_STATE_EVENT}:snapshot`, onChange);
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
      event.key === MCP_GATEWAY_PORT_KEY ||
      event.key === MCP_GATEWAY_GRANTS_KEY
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
  window.localStorage.setItem(
    MCP_GATEWAY_GRANTS_KEY,
    JSON.stringify(sanitizeMcpGatewayGrants(grants)),
  );
  window.dispatchEvent(new Event(MCP_GATEWAY_STATE_EVENT));
}

export function setMcpGatewayEnabled(enabled: boolean): void {
  window.localStorage.setItem(MCP_GATEWAY_ENABLED_KEY, String(enabled));
  window.dispatchEvent(new Event(MCP_GATEWAY_STATE_EVENT));
}

/** Outcome of the desktop starting its managed gateway session for the current configuration. */
export type McpGatewayStartup =
  | { readonly phase: "starting" }
  | { readonly phase: "ready" }
  | { readonly phase: "failed"; readonly message: string };
let currentMcpGatewayStartup: McpGatewayStartup = { phase: "starting" };

export function getMcpGatewayStartup(): McpGatewayStartup {
  return currentMcpGatewayStartup;
}

export function publishMcpGatewayStartup(startup: McpGatewayStartup): void {
  currentMcpGatewayStartup = startup;
  window.dispatchEvent(
    new CustomEvent<McpGatewayStartup>(`${MCP_GATEWAY_STATE_EVENT}:startup`, { detail: startup }),
  );
}

/** Electron wraps main-process errors as "Error invoking remote method '…': Name: message". */
export function mcpGatewayStartupMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  const message = raw.replace(/^Error invoking remote method '[^']*': (?:\w+: )?/u, "").trim();
  return message === "" ? "Gateway could not start." : message;
}

let restartGateway: (() => void) | null = null;

export function setMcpGatewayRestarter(restarter: (() => void) | null): void {
  restartGateway = restarter;
}

export function restartMcpGateway(): boolean {
  if (!restartGateway || !isMcpGatewayEnabled()) return false;
  restartGateway();
  return true;
}

import type { ServerConfig } from "@t3tools/contracts";
import * as Option from "effect/Option";

import type { ConnectionCatalogEntry } from "./catalog.ts";
import type { SupervisorConnectionState } from "./model.ts";

export type EnvironmentConnectionPhase =
  | "available"
  | "offline"
  | "connecting"
  | "reconnecting"
  | "connected"
  | "error"
  | "unsupported";

export interface EnvironmentConnectionPresentation {
  readonly phase: EnvironmentConnectionPhase;
  readonly error: string | null;
  readonly traceId: string | null;
}

export interface EnvironmentPresentation {
  readonly entry: ConnectionCatalogEntry;
  readonly connection: EnvironmentConnectionPresentation;
  readonly serverConfig: ServerConfig | null;
}

export function presentConnectionState(
  state: SupervisorConnectionState,
): EnvironmentConnectionPresentation {
  switch (state.phase) {
    case "available":
      return { phase: "available", error: null, traceId: null };
    case "offline":
      return { phase: "offline", error: null, traceId: null };
    case "connecting":
      return {
        phase: state.attempt <= 1 && state.lastFailure === null ? "connecting" : "reconnecting",
        error: state.lastFailure?.message ?? null,
        traceId: state.lastFailure?.traceId ?? null,
      };
    case "connected":
      return { phase: "connected", error: null, traceId: null };
    case "backoff":
      return {
        phase: "reconnecting",
        error: state.lastFailure?.message ?? null,
        traceId: state.lastFailure?.traceId ?? null,
      };
    case "blocked":
      return {
        phase: state.lastFailure?.reason === "unsupported" ? "unsupported" : "error",
        error: state.lastFailure?.message ?? null,
        traceId: state.lastFailure?.traceId ?? null,
      };
  }
}

export function connectionStatusText(connection: EnvironmentConnectionPresentation): string {
  switch (connection.phase) {
    case "available":
      return "Available";
    case "offline":
      return "Offline";
    case "connecting":
      return "Connecting...";
    case "reconnecting":
      return connection.error
        ? `Failed to connect. Reconnecting... Reason: ${connection.error}`
        : "Reconnecting...";
    case "connected":
      return "Connected";
    case "unsupported":
      return "Client not supported";
    case "error":
      return connection.error
        ? `Connection failed. Reason: ${connection.error}`
        : "Connection failed";
  }
}

export function connectionStatusTitle(connection: EnvironmentConnectionPresentation): string {
  if (connection.phase === "reconnecting" && connection.error) {
    return "Failed to connect. Reconnecting...";
  }
  return connectionStatusText({ ...connection, error: null });
}

export function presentEnvironmentConnection(
  state: SupervisorConnectionState,
): EnvironmentConnectionPresentation {
  return presentConnectionState(state);
}

/**
 * The address an agent outside T3 (Claude Code, Codex) uses to reach this
 * environment's MCP server. Only HTTPS and loopback addresses qualify: MCP
 * clients refuse to sign in through a plain-http token endpoint elsewhere.
 * SSH connections ride a local forward that disappears with the client, so
 * they have no stable address to hand out.
 */
export function environmentMcpUrl(input: {
  readonly entry: ConnectionCatalogEntry;
  readonly relayHttpBaseUrl?: string | undefined;
}): string | null {
  const httpBaseUrl =
    input.entry.target._tag === "RelayConnectionTarget"
      ? (input.relayHttpBaseUrl ?? null)
      : input.entry.target._tag === "SshConnectionTarget"
        ? null
        : connectionCatalogDisplayUrl(input.entry);
  if (httpBaseUrl === null) return null;
  let url: URL;
  try {
    url = new URL(httpBaseUrl);
  } catch {
    return null;
  }
  const loopback =
    url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) return null;
  url.pathname = "/mcp";
  url.search = "";
  url.hash = "";
  return url.toString();
}

export function connectionCatalogDisplayUrl(entry: ConnectionCatalogEntry): string | null {
  switch (entry.target._tag) {
    case "PrimaryConnectionTarget":
      return entry.target.httpBaseUrl;
    case "RelayConnectionTarget":
      return null;
    case "BearerConnectionTarget":
      return Option.isSome(entry.profile) && entry.profile.value._tag === "BearerConnectionProfile"
        ? entry.profile.value.httpBaseUrl
        : null;
    case "SshConnectionTarget":
      return Option.isSome(entry.profile) && entry.profile.value._tag === "SshConnectionProfile"
        ? `${entry.profile.value.target.username}@${entry.profile.value.target.hostname}`
        : null;
  }
}

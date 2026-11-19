import type { ServerConfig } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { mFallback, msg } from "gt-i18n";
import type { MFunctionType } from "gt-i18n/types";

import { type MarkedText, resolveMarkedText } from "../errors/translatable.ts";
import type { ConnectionCatalogEntry } from "./catalog.ts";
import type {
  ConnectionAttemptError,
  ConnectionTarget,
  SupervisorConnectionState,
} from "./model.ts";
import { connectionRouteId, connectionRoutes, routeHttpBaseUrl } from "./routes.ts";

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
  /** `error` as marked text, when the failure carries it. Read both through `connectionErrorText`. */
  readonly i18nError?: MarkedText;
  readonly traceId: string | null;
  readonly failureReason?: ConnectionAttemptError["reason"];
  /**
   * With phase "offline": this device is online but the host has not answered past the
   * grace period. Retries continue quietly, so it is neither an error nor reconnecting.
   */
  readonly unreachable?: true;
  readonly lastConnectedAt?: number;
  /** With phase "error": the host refused this device's credential, which only pairing again fixes. */
  readonly needsPairing?: true;
}

/**
 * Provider statuses are pushed every few minutes with fresh `checkedAt` stamps, and every root
 * coordinator reads environment presentations. Leaving them out keeps a presentation stable
 * across those pushes; provider readers subscribe to the server's providers atom instead.
 */
export type EnvironmentServerConfig = Omit<ServerConfig, "providers">;

export interface EnvironmentPresentation {
  readonly entry: ConnectionCatalogEntry;
  readonly connection: EnvironmentConnectionPresentation;
  readonly serverConfig: EnvironmentServerConfig | null;
  /** See `SupervisorConnectionState.refusedRouteIds`. */
  readonly refusedRouteIds: ReadonlyArray<string>;
}

function failureError(
  failure: SupervisorConnectionState["lastFailure"],
): Pick<EnvironmentConnectionPresentation, "error" | "i18nError" | "traceId" | "failureReason"> {
  return {
    error: failure?.message ?? null,
    traceId: failure?.traceId ?? null,
    ...(failure ? { failureReason: failure.reason } : {}),
  };
}

export function presentConnectionState(
  state: SupervisorConnectionState,
): EnvironmentConnectionPresentation {
  const lastConnectedAt =
    state.lastConnectedAt === undefined ? {} : { lastConnectedAt: state.lastConnectedAt };
  if (state.unreachable === true && (state.phase === "connecting" || state.phase === "backoff")) {
    return {
      phase: "offline",
      error: null,
      traceId: state.lastFailure?.traceId ?? null,
      ...(state.lastFailure ? { failureReason: state.lastFailure.reason } : {}),
      unreachable: true,
      ...lastConnectedAt,
    };
  }
  switch (state.phase) {
    case "available":
      return { phase: "available", error: null, traceId: null };
    case "offline":
      return { phase: "offline", error: null, traceId: null, ...lastConnectedAt };
    case "connecting":
      return {
        phase: state.attempt <= 1 && state.lastFailure === null ? "connecting" : "reconnecting",
        ...failureError(state.lastFailure),
      };
    case "connected":
      return { phase: "connected", error: null, traceId: null };
    case "backoff":
      return {
        phase: "reconnecting",
        ...failureError(state.lastFailure),
      };
    case "blocked":
      return {
        phase: state.lastFailure?.reason === "unsupported" ? "unsupported" : "error",
        ...(state.lastFailure?.reason === "authentication" && state.lastFailure.hop === "server"
          ? { needsPairing: true as const }
          : {}),
        ...failureError(state.lastFailure),
      };
  }
}

/** The connection's error in the active language, or null when it has none. */
export function connectionErrorText(
  connection: Pick<EnvironmentConnectionPresentation, "error" | "i18nError">,
  resolve: MFunctionType = mFallback,
): string | null {
  if (connection.error === null) return null;
  return connection.i18nError !== undefined
    ? resolveMarkedText(connection.i18nError, resolve)
    : connection.error;
}

export function connectionStatusText(
  connection: EnvironmentConnectionPresentation,
  resolve: MFunctionType = mFallback,
): string {
  const error = connectionErrorText(connection, resolve);
  switch (connection.phase) {
    case "available":
      return resolve(msg("Available", { $context: "connection status" }));
    case "offline":
      return resolve(msg("Offline", { $context: "connection status" }));
    case "connecting":
      return resolve(msg("Connecting..."));
    case "reconnecting":
      return error
        ? resolve(msg("Failed to connect. Reconnecting... Reason: {error}", { error }))
        : resolve(msg("Reconnecting..."));
    case "connected":
      return resolve(msg("Connected", { $context: "connection status" }));
    case "unsupported":
      return resolve(msg("Client not supported"));
    case "error":
      if (connection.needsPairing === true) return "Needs pairing again";
      return error
        ? resolve(msg("Connection failed. Reason: {error}", { error }))
        : resolve(msg("Connection failed"));
  }
}

/** A wall-clock time rather than "5 min ago", so the label never goes stale on screen. */
export function lastSeenLabel(lastConnectedAt: number, now: number): string {
  const day = new Intl.DateTimeFormat(undefined, {
    year: "numeric",
    month: "numeric",
    day: "numeric",
  });
  const format =
    day.format(lastConnectedAt) === day.format(now)
      ? new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" })
      : new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" });
  return `last seen ${format.format(lastConnectedAt)}`;
}

/** "Offline · last seen 2 h ago" from a roster's `lastSeenAt`, or "Offline" when it is unknown. */
export function offlineSinceLabel(lastSeenAt: number | null, now: number): string {
  if (lastSeenAt === null) return "Offline";
  const minutes = Math.floor(Math.max(0, now - lastSeenAt) / 60_000);
  const ago =
    minutes < 1
      ? "just now"
      : minutes < 60
        ? `${minutes} min ago`
        : minutes < 24 * 60
          ? `${Math.floor(minutes / 60)} h ago`
          : `${Math.floor(minutes / (24 * 60))} d ago`;
  return `Offline · last seen ${ago}`;
}

export function connectionStatusTitle(
  connection: EnvironmentConnectionPresentation,
  resolve: MFunctionType = mFallback,
): string {
  if (connection.phase === "reconnecting" && connection.error) {
    return resolve(msg("Failed to connect. Reconnecting..."));
  }
  return connectionStatusText({ ...connection, error: null }, resolve);
}

/**
 * The route this device is connected over comes first, then the other saved routes. SSH routes
 * ride a local forward that disappears with the client, so they have no stable address.
 */
export function environmentMcpUrl(input: {
  readonly entry: ConnectionCatalogEntry;
  readonly connectedTarget?: ConnectionTarget | null | undefined;
}): string | null {
  const connectedRouteId = input.connectedTarget ? connectionRouteId(input.connectedTarget) : null;
  const routes = connectionRoutes(input.entry);
  const connectedRoute = routes.find(
    (route) => connectionRouteId(route.target) === connectedRouteId,
  );
  for (const route of connectedRoute ? [connectedRoute, ...routes] : routes) {
    const httpBaseUrl = routeHttpBaseUrl(route);
    const mcpUrl = httpBaseUrl === null ? null : mcpUrlFromBase(httpBaseUrl);
    if (mcpUrl !== null) return mcpUrl;
  }
  return null;
}

function mcpUrlFromBase(httpBaseUrl: string): string | null {
  let url: URL;
  try {
    url = new URL(httpBaseUrl);
  } catch {
    return null;
  }
  url.pathname = "/mcp";
  url.search = "";
  url.hash = "";
  return url.toString();
}

export function connectionCatalogDisplayUrl(entry: ConnectionCatalogEntry): string | null {
  switch (entry.target._tag) {
    case "PrimaryConnectionTarget":
      return entry.target.httpBaseUrl;
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

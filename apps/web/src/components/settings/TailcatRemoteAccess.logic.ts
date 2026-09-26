import type {
  TailcatForwardStatus,
  TailcatPathProbe,
  TailcatRemoteAccessState,
  TailcatRuntimeInfo,
  TailcatServeStatus,
} from "@t3tools/contracts";
import { parseTailcatBridgeError, TAILCAT_BRIDGE_FALLBACK_DETAIL } from "~/connection/platform";

export type TailcatStatusBadgeVariant = "outline" | "warning" | "success" | "error";

export function tailcatStatusLabel(status: TailcatServeStatus): string {
  switch (status) {
    case "disabled":
      return "Disabled";
    case "starting":
      return "Starting…";
    case "ready":
      return "Ready";
    case "restarting":
      return "Restarting…";
    case "error":
      return "Error";
    case "unavailable":
      return "Unavailable";
  }
}

export function tailcatStatusBadgeVariant(status: TailcatServeStatus): TailcatStatusBadgeVariant {
  switch (status) {
    case "ready":
      return "success";
    case "starting":
    case "restarting":
      return "warning";
    case "error":
      return "error";
    case "disabled":
    case "unavailable":
      return "outline";
  }
}

/** "bundled 0.5.0", "system 0.5.0", "override 0.5.0"; null when the server has not resolved a runtime. */
export function tailcatRuntimeLabel(runtime: TailcatRuntimeInfo | null): string | null {
  return runtime === null ? null : `${runtime.source} ${runtime.version}`;
}

/**
 * What the connection-code card shows for the code it issued. The listener
 * reports an open pairing window while any unredeemed code is live, so once the
 * window has opened for this code, its closing before expiry means it was
 * redeemed.
 */
export function issuedConnectionCodeStatus(input: {
  readonly expiresAtMs: number;
  readonly nowMs: number;
  readonly pairingWindowOpened: boolean;
  readonly pairingOpen: boolean;
}): "live" | "expired" | "redeemed" {
  if (input.expiresAtMs <= input.nowMs) return "expired";
  if (input.pairingWindowOpened && !input.pairingOpen) return "redeemed";
  return "live";
}

/** "Direct", "Relay (via fra)", "Relay", or "Unknown" for a measured path. */
export function tailcatPathKindLabel(path: TailcatPathProbe): string {
  switch (path.kind) {
    case "direct":
      return "Direct";
    case "relay":
      return path.via ? `Relay (via ${path.via})` : "Relay";
    case "unknown":
      return "Unknown";
  }
}

/** Saved-row subtitle: the transport, then the measured path when a probe ran. */
export function tailcatPathLabel(path: TailcatPathProbe | null): string {
  if (path === null || path.kind === "unknown") return "Tailcat";
  return `Tailcat · ${tailcatPathKindLabel(path)}`;
}

export function tailcatForwardStatusLabel(status: TailcatForwardStatus): string {
  switch (status) {
    case "starting":
      return "Starting";
    case "ready":
      return "Ready";
    case "failed":
      return "Failed";
  }
}

/**
 * Strips the Electron IPC and `[tailcat:<code>]` prefixes so an error reads
 * like a sentence in the dialog. Connection errors already arrive clean.
 */
export function formatTailcatConnectionError(error: unknown, fallback: string): string {
  if (!(error instanceof Error) && typeof error !== "string") {
    return fallback;
  }
  const { detail } = parseTailcatBridgeError(error);
  return detail === TAILCAT_BRIDGE_FALLBACK_DETAIL ? fallback : detail;
}

/** The state has no secrets (keys are public, sessions are ids), so it can be copied whole. */
export function tailcatDiagnosticsJson(state: TailcatRemoteAccessState): string {
  return JSON.stringify(state, null, 2);
}

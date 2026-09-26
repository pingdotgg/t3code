import type {
  TailcatConnectionCodePayload,
  TailcatForwardStatus,
  TailcatPathProbe,
  TailcatRemoteAccessState,
  TailcatRuntimeInfo,
  TailcatServeStatus,
} from "@t3tools/contracts";
import { parseTailcatBridgeError, TAILCAT_BRIDGE_FALLBACK_DETAIL } from "~/connection/platform";
import { describeT3ConnectionCode } from "@t3tools/shared/t3ConnectionCode";

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

type TailcatConnectionCodePreview =
  | { readonly kind: "empty" }
  | { readonly kind: "invalid"; readonly message: string }
  | { readonly kind: "peer-code"; readonly message: string }
  | {
      readonly kind: "valid";
      readonly payload: TailcatConnectionCodePayload;
      readonly expiresAtMs: number;
    };

/**
 * Live feedback for the connection-code field: memoize on the pasted text and
 * judge expiry per tick. A federation peer code is recognised and redirected
 * rather than reported as damaged.
 */
export function parseTailcatConnectionCodePreview(raw: string): TailcatConnectionCodePreview {
  const preview = describeT3ConnectionCode(raw, "tailcat");
  return preview.kind === "other-kind" ? { kind: "peer-code", message: preview.message } : preview;
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

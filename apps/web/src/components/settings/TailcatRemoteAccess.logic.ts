import type {
  TailcatConnectionCodePayload,
  TailcatForwardStatus,
  TailcatPathProbe,
  TailcatRemoteAccessState,
  TailcatRuntimeInfo,
  TailcatServeStatus,
} from "@t3tools/contracts";
import {
  T3ConnectionCodeInvalidError,
  decodeTailcatConnectionCode,
  isT3ConnectionCode,
  peekT3ConnectionCodeKind,
} from "@t3tools/shared/t3ConnectionCode";
import * as Schema from "effect/Schema";

const isCodeInvalidError = Schema.is(T3ConnectionCodeInvalidError);

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

/** The last eight hex characters of a `nodekey:<hex>` value, enough to tell devices apart. */
export function tailcatNodeKeyFingerprint(nodeKey: string): string {
  const hex = nodeKey.startsWith("nodekey:") ? nodeKey.slice("nodekey:".length) : nodeKey;
  return hex.slice(-8);
}

/** Whole minutes a freshly minted code stays valid, never below one. */
export function connectionCodeLifetimeMinutes(expiresAt: string, nowMs: number): number {
  const expiresAtMs = Date.parse(expiresAt);
  if (Number.isNaN(expiresAtMs)) return 1;
  return Math.max(1, Math.round((expiresAtMs - nowMs) / 60_000));
}

export type TailcatConnectionCodePreview =
  | { readonly kind: "empty" }
  | { readonly kind: "invalid"; readonly message: string }
  | { readonly kind: "peer-code"; readonly message: string }
  | {
      readonly kind: "valid";
      readonly payload: TailcatConnectionCodePayload;
      readonly expired: boolean;
      readonly hasPairingToken: boolean;
    };

/**
 * Live feedback for the connection-code field. A federation peer code is
 * recognised and redirected rather than reported as damaged, and an expired
 * code is still shown so the user knows which machine to ask again.
 */
export function describeTailcatConnectionCode(
  raw: string,
  nowMs: number,
): TailcatConnectionCodePreview {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return { kind: "empty" };
  }
  if (!isT3ConnectionCode(trimmed)) {
    return {
      kind: "invalid",
      message: "Paste the full connection code. It starts with t3c://tailcat/.",
    };
  }
  if (peekT3ConnectionCodeKind(trimmed) === "peer") {
    return {
      kind: "peer-code",
      message: "This is a federation peer code. Add it under Federation → Add peer instead.",
    };
  }
  try {
    const payload = decodeTailcatConnectionCode(trimmed);
    return {
      kind: "valid",
      payload,
      expired: payload.expiresAt !== undefined && Date.parse(payload.expiresAt) <= nowMs,
      hasPairingToken: payload.pairingToken !== undefined,
    };
  } catch (cause) {
    return {
      kind: "invalid",
      message: isCodeInvalidError(cause)
        ? cause.message
        : "This Tailcat connection code could not be read.",
    };
  }
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
    case "stopped":
      return "Stopped";
  }
}

/**
 * Strips the Electron IPC and `[tailcat:<code>]` prefixes so an error reads
 * like a sentence in the dialog. Connection errors already arrive clean.
 */
export function formatTailcatConnectionError(error: unknown, fallback: string): string {
  const raw = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  const cleaned = raw
    .replace(/^Error invoking remote method '[^']+':\s*/u, "")
    .replace(/^(?:[A-Za-z]*Error):\s*/u, "")
    .replace(/^\[tailcat:[a-z-]+\]\s*/u, "")
    .trim();
  return cleaned.length > 0 ? cleaned : fallback;
}

/** The state has no secrets (keys are public, sessions are ids), so it can be copied whole. */
export function tailcatDiagnosticsJson(state: TailcatRemoteAccessState): string {
  return JSON.stringify(state, null, 2);
}

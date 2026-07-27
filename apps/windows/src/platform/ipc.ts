/**
 * Typed bridge to the Tauri shell (`src-tauri/src/lib.rs`).
 *
 * Every shape here mirrors a `#[derive(Serialize)]` struct or a
 * `#[tauri::command]` signature on the Rust side. Keeping them in one file
 * means a rename on either side fails the build rather than silently
 * returning `undefined` at runtime.
 */

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

/** Mirrors `SidecarState` in `src-tauri/src/sidecar/process.rs`. */
export type SidecarState =
  | { readonly kind: "idle" }
  | { readonly kind: "launching"; readonly restartAttempt: number }
  | { readonly kind: "ready"; readonly pid: number }
  | { readonly kind: "crashed"; readonly reason: string; readonly restartAttempt: number }
  | { readonly kind: "stopped" };

/** Mirrors `SidecarEndpoint` in `src-tauri/src/lib.rs`. */
export interface SidecarEndpoint {
  readonly httpBaseUrl: string;
  readonly wsBaseUrl: string;
  readonly bootstrapToken: string;
  readonly port: number;
  readonly host: string;
  readonly baseDir: string;
  readonly logDirectory: string;
}

/** Mirrors `PairingEndpoint` in `src-tauri/src/lib.rs`. */
export interface PairingEndpoint {
  readonly origin: string;
  readonly address: string;
  readonly port: number;
}

export type Backdrop = "none" | "mica" | "mica-alt" | "acrylic";

/** Mirrors `LaunchPreferences` in `src-tauri/src/preferences.rs`. */
export interface LaunchPreferences {
  readonly allowLanAccess: boolean;
  readonly tailscaleServeEnabled: boolean;
  readonly backdrop: Backdrop;
}

export const SIDECAR_STATE_EVENT = "sidecar://state";
export const SIDECAR_ENDPOINT_EVENT = "sidecar://endpoint";

export function sidecarEndpoint(): Promise<SidecarEndpoint | null> {
  return invoke<SidecarEndpoint | null>("sidecar_endpoint");
}

export function sidecarSnapshot(): Promise<SidecarState> {
  return invoke<SidecarState>("sidecar_snapshot");
}

export function restartSidecar(): Promise<void> {
  return invoke<void>("sidecar_restart");
}

export function loadLaunchPreferences(): Promise<LaunchPreferences> {
  return invoke<LaunchPreferences>("launch_preferences");
}

export function saveLaunchPreferences(preferences: LaunchPreferences): Promise<void> {
  return invoke<void>("set_launch_preferences", { preferences });
}

export function setBackdrop(backdrop: Backdrop): Promise<void> {
  return invoke<void>("set_backdrop", { backdrop });
}

export function pairingEndpoint(): Promise<PairingEndpoint | null> {
  return invoke<PairingEndpoint | null>("pairing_endpoint");
}

export function readSecret(deviceId: string): Promise<string | null> {
  return invoke<string | null>("secret_read", { deviceId });
}

export function writeSecret(deviceId: string, token: string): Promise<void> {
  return invoke<void>("secret_write", { deviceId, token });
}

export function deleteSecret(deviceId: string): Promise<void> {
  return invoke<void>("secret_delete", { deviceId });
}

export function onSidecarState(handler: (state: SidecarState) => void): Promise<UnlistenFn> {
  return listen<SidecarState>(SIDECAR_STATE_EVENT, (event) => handler(event.payload));
}

export function onSidecarEndpoint(
  handler: (endpoint: SidecarEndpoint) => void,
): Promise<UnlistenFn> {
  return listen<SidecarEndpoint>(SIDECAR_ENDPOINT_EVENT, (event) => handler(event.payload));
}

/**
 * The connection phase the shell shows, projected from the sidecar's
 * lifecycle. Mirrors `LiveBackend.handleSidecarState`'s mapping on macOS:
 * the first launch reads as "launching the server", every subsequent attempt
 * reads as reconnecting so the UI keeps its spinner instead of erroring out.
 */
export type ConnectionPhase =
  | { readonly kind: "idle" }
  | { readonly kind: "launchingServer" }
  | { readonly kind: "connecting" }
  | { readonly kind: "reconnecting"; readonly attempt: number }
  | { readonly kind: "ready" }
  | { readonly kind: "failed"; readonly detail: string };

export function phaseForSidecarState(state: SidecarState): ConnectionPhase {
  switch (state.kind) {
    case "idle":
      return { kind: "idle" };
    case "launching":
      return state.restartAttempt === 0
        ? { kind: "launchingServer" }
        : { kind: "reconnecting", attempt: state.restartAttempt };
    case "ready":
      // The sidecar is up; the socket session still has to authenticate and
      // subscribe before the shell is usable.
      return { kind: "connecting" };
    case "crashed":
      // The supervisor restarts with backoff, so this is not terminal.
      return { kind: "reconnecting", attempt: state.restartAttempt + 1 };
    case "stopped":
      return { kind: "idle" };
  }
}

/** Human-readable status line for the connection pill. */
export function phaseLabel(phase: ConnectionPhase): string {
  switch (phase.kind) {
    case "idle":
      return "Idle";
    case "launchingServer":
      return "Launching Server…";
    case "connecting":
      return "Connecting…";
    case "reconnecting":
      return phase.attempt <= 1 ? "Reconnecting…" : `Reconnecting… (${phase.attempt})`;
    case "ready":
      return "Connected";
    case "failed":
      return phase.detail;
  }
}

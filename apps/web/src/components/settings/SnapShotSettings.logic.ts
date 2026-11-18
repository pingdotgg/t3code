import type { ClientSettingsPatch, DesktopSnapShotState, SnapShotSound } from "@t3tools/contracts";
import { msg } from "gt-react";

import { m, type MessageResolver } from "../../i18n/messages";
import {
  captureSetupBackend,
  captureSetupDesktopName,
  captureSetupAccessReady,
  captureSetupMacPermissionsReady,
} from "./SnapShotSetupDialog.logic";

export function snapShotStatus(
  state: DesktopSnapShotState | null,
  enabled: boolean,
  resolve: MessageResolver = m,
): string {
  if (!state) return resolve(msg("Checking snapshots…"));
  if (state.mode === "unavailable")
    return state.message ?? resolve(msg("Not supported on this platform."));
  if (!enabled) return resolve(msg("Turn this on to set up snapshots."));
  return snapShotSetupSummary(state, enabled, resolve);
}

export function snapShotSetupSummary(
  state: DesktopSnapShotState,
  enabled: boolean,
  resolve: MessageResolver = m,
): string {
  if (state.message) return resolve(msg("Capture needs attention"));
  if (state.linuxBackend === "hyprland" && state.hyprlandHelper?.status !== "ready")
    return state.hyprlandHelper?.status === "error"
      ? resolve(msg("Check capture access in setup"))
      : resolve(msg("Install the capture helper to continue"));
  if (captureSetupBackend(state) === "gnome" && state.gnomeExtension?.status !== "enabled")
    return resolve(msg("Set up active-window snapshots"));
  if (captureSetupBackend(state) === "kde" && state.kdeHelper?.status !== "ready")
    return state.kdeHelper?.status === "error"
      ? resolve(msg("Check capture access in setup"))
      : resolve(msg("Install the capture helper to continue"));
  if (captureSetupBackend(state) === "picker")
    return resolve(msg("Manual capture only. You'll choose a window each time"));
  if (!enabled) return resolve(msg("Enable capture to continue"));
  if (state.shortcutPending)
    return state.linuxBackend === "hyprland"
      ? resolve(msg("Connecting your shortcut…"))
      : resolve(msg("Waiting for shortcut permission"));
  if (state.shortcutVerified) return resolve(msg("Ready to capture"));
  if (state.linuxBackend === "niri" && state.shortcutBinding)
    return resolve(msg("Use your shortcut from another app"));
  if (state.linuxBackend === "hyprland" && state.shortcutActionRegistered)
    return resolve(msg("Use your shortcut from another app"));
  if (state.shortcutRegistered)
    return state.shortcutLabel ? resolve(msg("Ready to capture")) : resolve(msg("Shortcut saved"));
  return resolve(msg("Finish shortcut setup"));
}

export function snapShotShortcutStatus(
  state: DesktopSnapShotState | null,
  resolve: MessageResolver = m,
): string | null {
  if (!state) return null;
  if (state.linuxBackend === "hyprland") return state.shortcutMessage;
  if (state.shortcutPending)
    return resolve(msg("Approve the shortcut permission prompt to continue."));
  if (state.shortcutRegistered)
    return state.mode === "portal" ? null : resolve(msg("Shortcut saved."));
  return state.shortcutMessage;
}

export function snapShotSetupButtonLabel(
  state: DesktopSnapShotState | null,
  resolve: MessageResolver = m,
): string {
  if (!state) return resolve(msg("Continue setup"));
  if (captureSetupAccessReady(state)) return resolve(msg("Manage capture"));
  const desktop = captureSetupDesktopName(state);
  return desktop
    ? resolve(msg("Set up {desktop} capture", { desktop }))
    : resolve(msg("Continue setup"));
}

export function snapShotSetupComplete(
  state: DesktopSnapShotState | null,
  includeAccessibility: boolean,
): boolean {
  if (state?.windows) return true;
  return (
    state?.macPermissions !== undefined &&
    captureSetupAccessReady(state) &&
    captureSetupMacPermissionsReady(state, includeAccessibility) &&
    state.shortcutRegistered
  );
}

export type SnapShotSoundSelection = SnapShotSound | "off";

export function snapShotFeedbackUnavailableMessage(
  state: DesktopSnapShotState | null,
  resolve: MessageResolver = m,
): string | undefined {
  if (state?.mode !== "portal" || state.linuxFeedbackAvailable) return undefined;
  if (state.linuxBackend === "hyprland")
    return state.hyprlandHelper?.status === "ready"
      ? resolve(msg("Capture effects aren't available on this desktop."))
      : resolve(msg("Install or update the capture helper to enable effects."));
  if (state.linuxBackend === "niri")
    return resolve(msg("Capture effects aren't available on Niri."));
  if (state.linuxBackend === "kde")
    return state.kdeHelper?.status === "ready"
      ? resolve(msg("Capture effects aren't available on this desktop."))
      : resolve(msg("Install or update the capture helper to enable effects."));
  return state.linuxBackend === "gnome-extension"
    ? resolve(msg("Update the GNOME extension, then sign out and back in to enable effects."))
    : captureSetupBackend(state) === "gnome"
      ? resolve(msg("Finish extension setup to enable effects."))
      : resolve(msg("Capture effects aren't available on this desktop."));
}

export function snapShotDescription(
  state: DesktopSnapShotState | null,
  resolve: MessageResolver = m,
): string {
  return state?.mode === "portal" && captureSetupBackend(state) === "picker"
    ? resolve(msg("Automatic capture isn't available here. Choose a window instead."))
    : resolve(msg("Capture a window and attach it to your current draft."));
}

export function snapShotAccessibilityUnavailableMessage(
  state: DesktopSnapShotState | null,
  resolve: MessageResolver = m,
): string | undefined {
  if (state?.mode !== "portal") return undefined;
  if (state.linuxBackend === "picker" || state.linuxBackend === "screenshot-portal")
    return resolve(msg("This desktop only provides a screenshot."));
  return undefined;
}

export function snapShotUnavailableMessage(
  hasBridge: boolean,
  resolve: MessageResolver = m,
): string | undefined {
  if (hasBridge) return undefined;
  return typeof window !== "undefined" && window.desktopBridge
    ? resolve(msg("Update the desktop app to use snapshots."))
    : resolve(msg("Only available in the desktop app."));
}

export interface SnapShotCaptureHelperStatus {
  readonly tone: "success" | "warning" | "error";
  readonly label: string;
  readonly description: string;
  readonly needsSetup: boolean;
}

/** The Advanced > Capture helper row: what this desktop captures with, and whether it is ready. */
export function snapShotCaptureHelperStatus(
  state: DesktopSnapShotState | null,
  resolve: MessageResolver = m,
): SnapShotCaptureHelperStatus | null {
  if (!state || state.mode === "unavailable") return null;
  if (state.linuxBackend === "kde" || state.linuxBackend === "hyprland") {
    const helper = state.linuxBackend === "hyprland" ? state.hyprlandHelper : state.kdeHelper;
    const desktop = state.linuxBackend === "hyprland" ? "Hyprland" : "KDE";
    if (helper?.status === "ready")
      return {
        tone: "success",
        label: resolve(msg("Ready", { $context: "capture helper status" })),
        description: resolve(msg("Captures windows on {desktop}.", { desktop })),
        needsSetup: false,
      };
    if (helper?.status === "update-required")
      return {
        tone: "warning",
        label: resolve(msg("Update available")),
        description: helper.message,
        needsSetup: true,
      };
    if (helper?.status === "error")
      return {
        tone: "error",
        label: resolve(msg("Error", { $context: "capture helper status" })),
        description: helper.message,
        needsSetup: true,
      };
    return {
      tone: "warning",
      label: resolve(msg("Not installed")),
      description:
        helper?.message ??
        resolve(msg("Install the helper to capture windows on {desktop}.", { desktop })),
      needsSetup: true,
    };
  }
  if (state.linuxBackend === "gnome-extension") {
    const extension = state.gnomeExtension;
    if (extension?.status === "enabled")
      return {
        tone: "success",
        label: resolve(msg("Ready", { $context: "capture helper status" })),
        description: resolve(msg("Captures windows with the GNOME extension.")),
        needsSetup: false,
      };
    return {
      tone: extension?.status === "error" ? "error" : "warning",
      label: resolve(msg("Setup needed")),
      description: resolve(msg("Set up the GNOME extension to capture windows.")),
      needsSetup: true,
    };
  }
  return {
    tone: "success",
    label: resolve(msg("Ready", { $context: "capture helper status" })),
    description: resolve(msg("Included with T3 Code. No download needed.")),
    needsSetup: false,
  };
}

export function snapShotSoundPatch(sound: SnapShotSoundSelection): ClientSettingsPatch {
  return sound === "off"
    ? { snapShotPlaySound: false }
    : { snapShotPlaySound: true, snapShotSound: sound };
}

export function createRecordingRequestTracker() {
  let currentRequest: symbol | null = null;

  return {
    tryBegin() {
      if (currentRequest) return null;
      currentRequest = Symbol();
      return currentRequest;
    },
    clear() {
      currentRequest = null;
    },
    owns(request: symbol) {
      return currentRequest === request;
    },
  };
}

import type { ClientSettingsPatch, DesktopSnapShotState, SnapShotSound } from "@t3tools/contracts";
import {
  captureSetupBackend,
  captureSetupDesktopName,
  captureSetupAccessReady,
  captureSetupMacPermissionsReady,
} from "./SnapShotSetupDialog.logic";

export function snapShotStatus(state: DesktopSnapShotState | null, enabled: boolean): string {
  if (!state) return "Checking snapshots…";
  if (state.mode === "unavailable") return state.message ?? "Not supported on this platform.";
  if (!enabled) return "Turn this on to set up snapshots.";
  return snapShotSetupSummary(state, enabled);
}

export function snapShotSetupSummary(state: DesktopSnapShotState, enabled: boolean): string {
  if (state.message) return "Capture needs attention";
  if (state.linuxBackend === "hyprland" && state.hyprlandHelper?.status !== "ready")
    return state.hyprlandHelper?.status === "error"
      ? "Check capture access in setup"
      : "Install the capture helper to continue";
  if (captureSetupBackend(state) === "gnome" && state.gnomeExtension?.status !== "enabled")
    return "Set up active-window snapshots";
  if (captureSetupBackend(state) === "kde" && state.kdeHelper?.status !== "ready")
    return state.kdeHelper?.status === "error"
      ? "Check capture access in setup"
      : "Install the capture helper to continue";
  if (captureSetupBackend(state) === "picker")
    return "Manual capture only. You'll choose a window each time";
  if (!enabled) return "Enable capture to continue";
  if (state.shortcutPending)
    return state.linuxBackend === "hyprland"
      ? "Connecting your shortcut…"
      : "Waiting for shortcut permission";
  if (state.shortcutVerified) return "Ready to capture";
  if (state.linuxBackend === "niri" && state.shortcutBinding)
    return "Use your shortcut from another app";
  if (state.linuxBackend === "hyprland" && state.shortcutActionRegistered)
    return "Use your shortcut from another app";
  if (state.shortcutRegistered) return state.shortcutLabel ? "Ready to capture" : "Shortcut saved";
  return "Finish shortcut setup";
}

export function snapShotShortcutStatus(state: DesktopSnapShotState | null): string | null {
  if (!state) return null;
  if (state.linuxBackend === "hyprland") return state.shortcutMessage;
  if (state.shortcutPending) return "Approve the shortcut permission prompt to continue.";
  if (state.shortcutRegistered) return state.mode === "portal" ? null : "Shortcut saved.";
  return state.shortcutMessage;
}

export function snapShotSetupButtonLabel(state: DesktopSnapShotState | null): string {
  if (!state) return "Continue setup";
  if (captureSetupAccessReady(state)) return "Manage capture";
  const desktop = captureSetupDesktopName(state);
  return desktop ? `Set up ${desktop} capture` : "Continue setup";
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
): string | undefined {
  if (state?.mode !== "portal" || state.linuxFeedbackAvailable) return undefined;
  if (state.linuxBackend === "hyprland")
    return state.hyprlandHelper?.status === "ready"
      ? "Capture effects aren't available on this desktop."
      : "Install or update the capture helper to enable effects.";
  if (state.linuxBackend === "niri") return "Capture effects aren't available on Niri.";
  if (state.linuxBackend === "kde")
    return state.kdeHelper?.status === "ready"
      ? "Capture effects aren't available on this desktop."
      : "Install or update the capture helper to enable effects.";
  return state.linuxBackend === "gnome-extension"
    ? "Update the GNOME extension, then sign out and back in to enable effects."
    : captureSetupBackend(state) === "gnome"
      ? "Finish extension setup to enable effects."
      : "Capture effects aren't available on this desktop.";
}

export function snapShotDescription(state: DesktopSnapShotState | null): string {
  return state?.mode === "portal" && captureSetupBackend(state) === "picker"
    ? "Automatic capture isn't available here. Choose a window instead."
    : "Capture a window and attach it to your current draft.";
}

export function snapShotAccessibilityUnavailableMessage(
  state: DesktopSnapShotState | null,
): string | undefined {
  if (state?.mode !== "portal") return undefined;
  if (state.linuxBackend === "picker" || state.linuxBackend === "screenshot-portal")
    return "This desktop only provides a screenshot.";
  return undefined;
}

export function snapShotUnavailableMessage(hasBridge: boolean): string | undefined {
  if (hasBridge) return undefined;
  return typeof window !== "undefined" && window.desktopBridge
    ? "Update the desktop app to use snapshots."
    : "Only available in the desktop app.";
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
): SnapShotCaptureHelperStatus | null {
  if (!state || state.mode === "unavailable") return null;
  if (state.linuxBackend === "kde" || state.linuxBackend === "hyprland") {
    const helper = state.linuxBackend === "hyprland" ? state.hyprlandHelper : state.kdeHelper;
    const desktop = state.linuxBackend === "hyprland" ? "Hyprland" : "KDE";
    if (helper?.status === "ready")
      return {
        tone: "success",
        label: "Ready",
        description: `Captures windows on ${desktop}.`,
        needsSetup: false,
      };
    if (helper?.status === "update-required")
      return {
        tone: "warning",
        label: "Update available",
        description: helper.message,
        needsSetup: true,
      };
    if (helper?.status === "error")
      return { tone: "error", label: "Error", description: helper.message, needsSetup: true };
    return {
      tone: "warning",
      label: "Not installed",
      description: helper?.message ?? `Install the helper to capture windows on ${desktop}.`,
      needsSetup: true,
    };
  }
  if (state.linuxBackend === "gnome-extension") {
    const extension = state.gnomeExtension;
    if (extension?.status === "enabled")
      return {
        tone: "success",
        label: "Ready",
        description: "Captures windows with the GNOME extension.",
        needsSetup: false,
      };
    return {
      tone: extension?.status === "error" ? "error" : "warning",
      label: "Setup needed",
      description: "Set up the GNOME extension to capture windows.",
      needsSetup: true,
    };
  }
  return {
    tone: "success",
    label: "Ready",
    description: "Included with T3 Code. No download needed.",
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

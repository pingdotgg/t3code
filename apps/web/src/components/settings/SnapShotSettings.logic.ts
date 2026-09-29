import { translate } from "@t3tools/i18n";
import type { ClientSettingsPatch, DesktopSnapShotState, SnapShotSound } from "@t3tools/contracts";
import {
  captureSetupBackend,
  captureSetupDesktopName,
  captureSetupAccessReady,
  captureSetupMacPermissionsReady,
} from "./SnapShotSetupDialog.logic";

export function snapShotStatus(state: DesktopSnapShotState | null, enabled: boolean): string {
  if (!state) return translate("common:uiCheckingSnapshots", "Checking snapshots…");
  if (state.mode === "unavailable")
    return (
      state.message ??
      translate("common:uiNotSupportedOnPlatform", "Not supported on this platform.")
    );
  if (!enabled)
    return translate("common:uiTurnOnToSetUpSnapshots", "Turn this on to set up snapshots.");
  return snapShotSetupSummary(state, enabled);
}

export function snapShotSetupSummary(state: DesktopSnapShotState, enabled: boolean): string {
  if (state.message)
    return translate("common:uiSnapShotCaptureNeedsAttention", "Capture needs attention");
  if (state.linuxBackend === "hyprland" && state.hyprlandHelper?.status !== "ready")
    return state.hyprlandHelper?.status === "error"
      ? translate("common:uiCheckCaptureAccessInSetup", "Check capture access in setup")
      : translate(
          "common:uiInstallCaptureHelperToContinue",
          "Install the capture helper to continue",
        );
  if (captureSetupBackend(state) === "gnome" && state.gnomeExtension?.status !== "enabled")
    return translate("common:uiSetUpActiveWindowSnapshots", "Set up active-window snapshots");
  if (captureSetupBackend(state) === "kde" && state.kdeHelper?.status !== "ready")
    return state.kdeHelper?.status === "error"
      ? translate("common:uiCheckCaptureAccessInSetup", "Check capture access in setup")
      : translate(
          "common:uiInstallCaptureHelperToContinue",
          "Install the capture helper to continue",
        );
  if (captureSetupBackend(state) === "picker")
    return translate(
      "common:uiManualCaptureOnly",
      "Manual capture only — you'll choose a window each time",
    );
  if (!enabled) return translate("common:uiEnableCaptureToContinue", "Enable capture to continue");
  if (state.shortcutPending)
    return state.linuxBackend === "hyprland"
      ? translate("common:uiConnectingShortcut", "Connecting your shortcut…")
      : translate("common:uiWaitingShortcutPermission", "Waiting for shortcut permission");
  if (state.shortcutVerified) return translate("common:uiReadyToCapture", "Ready to capture");
  if (state.linuxBackend === "niri" && state.shortcutBinding)
    return translate("common:uiUseShortcutFromAnotherApp", "Use your shortcut from another app");
  if (state.linuxBackend === "hyprland" && state.shortcutActionRegistered)
    return translate("common:uiUseShortcutFromAnotherApp", "Use your shortcut from another app");
  if (state.shortcutRegistered)
    return state.shortcutLabel
      ? translate("common:uiReadyToCapture", "Ready to capture")
      : translate("common:uiShortcutSaved", "Shortcut saved");
  return translate("common:uiFinishShortcutSetup", "Finish shortcut setup");
}

export function snapShotShortcutStatus(state: DesktopSnapShotState | null): string | null {
  if (!state) return null;
  if (state.linuxBackend === "hyprland") return state.shortcutMessage;
  if (state.shortcutPending)
    return translate(
      "common:uiApproveShortcutPermissionPrompt",
      "Approve the shortcut permission prompt to continue.",
    );
  if (state.shortcutRegistered)
    return state.mode === "portal" ? null : translate("common:uiShortcutSaved", "Shortcut saved.");
  return state.shortcutMessage;
}

export function snapShotSetupButtonLabel(state: DesktopSnapShotState | null): string {
  if (!state) return translate("common:uiContinueSetup", "Continue setup");
  if (captureSetupAccessReady(state)) return translate("common:uiManageCapture", "Manage capture");
  const desktop = captureSetupDesktopName(state);
  return desktop
    ? translate("common:uiSetUpDesktopCapture", "Set up {{name}} capture", { name: desktop })
    : translate("common:uiContinueSetup", "Continue setup");
}

// Windows needs no permissions or setup: turning capture on is enough. macOS setup
// has nothing left to manage once permissions and the shortcut are in place; the
// shortcut row stays editable inline. Revoking a permission brings the button back
// as "Continue setup" through the state message.
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
      ? translate(
          "common:uiCaptureEffectsUnavailable",
          "Capture effects aren't available on this desktop.",
        )
      : translate(
          "common:uiInstallOrUpdateCaptureHelperForEffects",
          "Install or update the capture helper to enable effects.",
        );
  if (state.linuxBackend === "niri")
    return translate(
      "common:uiCaptureEffectsUnavailableOnNiri",
      "Capture effects aren't available on Niri.",
    );
  if (state.linuxBackend === "kde")
    return state.kdeHelper?.status === "ready"
      ? translate(
          "common:uiCaptureEffectsUnavailable",
          "Capture effects aren't available on this desktop.",
        )
      : translate(
          "common:uiInstallOrUpdateCaptureHelperForEffects",
          "Install or update the capture helper to enable effects.",
        );
  return state.linuxBackend === "gnome-extension"
    ? translate(
        "common:uiUpdateGnomeExtensionForEffects",
        "Update the GNOME extension, then sign out and back in to enable effects.",
      )
    : captureSetupBackend(state) === "gnome"
      ? translate(
          "common:uiFinishExtensionSetupForEffects",
          "Finish extension setup to enable effects.",
        )
      : translate(
          "common:uiCaptureEffectsUnavailable",
          "Capture effects aren't available on this desktop.",
        );
}

export function snapShotDescription(state: DesktopSnapShotState | null): string {
  return state?.mode === "portal" && captureSetupBackend(state) === "picker"
    ? translate(
        "common:uiAutomaticCaptureUnavailable",
        "Automatic capture isn't available here. Choose a window instead.",
      )
    : translate(
        "common:uiCaptureWindowAndAttachDraft",
        "Capture a window and attach it to your current draft.",
      );
}

export function snapShotAccessibilityUnavailableMessage(
  state: DesktopSnapShotState | null,
): string | undefined {
  if (state?.mode !== "portal") return undefined;
  if (state.linuxBackend === "picker" || state.linuxBackend === "screenshot-portal")
    return translate(
      "common:uiDesktopOnlyProvidesScreenshot",
      "This desktop only provides a screenshot.",
    );
  return undefined;
}

export function snapShotUnavailableMessage(hasBridge: boolean): string | undefined {
  if (hasBridge) return undefined;
  return typeof window !== "undefined" && window.desktopBridge
    ? translate("common:uiUpdateDesktopAppForSnapshots", "Update the desktop app to use snapshots.")
    : translate("common:uiSnapshotsDesktopOnly", "Only available in the desktop app.");
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

import { createTranslator, type TranslateFn } from "@t3tools/client-runtime/i18n";
import type { ClientSettingsPatch, DesktopSnapShotState, SnapShotSound } from "@t3tools/contracts";
import {
  captureSetupBackend,
  captureSetupDesktopName,
  captureSetupAccessReady,
  captureSetupMacPermissionsReady,
} from "./SnapShotSetupDialog.logic";

export function snapShotStatus(
  state: DesktopSnapShotState | null,
  enabled: boolean,
  t: TranslateFn = createTranslator("en"),
): string {
  if (!state) return t("settings.providers.snapshot.status.checking");
  if (state.mode === "unavailable")
    return state.message ?? t("settings.providers.snapshot.status.unsupported");
  if (!enabled) return t("settings.providers.snapshot.status.turnOn");
  return snapShotSetupSummary(state, enabled, t);
}

export function snapShotSetupSummary(
  state: DesktopSnapShotState,
  enabled: boolean,
  t: TranslateFn = createTranslator("en"),
): string {
  if (state.message) return t("settings.providers.snapshot.status.attention");
  if (state.linuxBackend === "hyprland" && state.hyprlandHelper?.status !== "ready")
    return state.hyprlandHelper?.status === "error"
      ? t("settings.providers.snapshot.status.checkAccess")
      : t("settings.providers.snapshot.status.installHelper");
  if (captureSetupBackend(state) === "gnome" && state.gnomeExtension?.status !== "enabled")
    return t("settings.providers.snapshot.status.activeWindow");
  if (captureSetupBackend(state) === "kde" && state.kdeHelper?.status !== "ready")
    return state.kdeHelper?.status === "error"
      ? t("settings.providers.snapshot.status.checkAccess")
      : t("settings.providers.snapshot.status.installHelper");
  if (captureSetupBackend(state) === "picker")
    return t("settings.providers.snapshot.status.manualOnly");
  if (!enabled) return t("settings.providers.snapshot.status.enableCapture");
  if (state.shortcutPending)
    return state.linuxBackend === "hyprland"
      ? t("settings.providers.snapshot.status.connecting")
      : t("settings.providers.snapshot.status.waitingPermission");
  if (state.shortcutVerified) return t("settings.providers.snapshot.status.ready");
  if (state.linuxBackend === "niri" && state.shortcutBinding)
    return t("settings.providers.snapshot.status.useShortcut");
  if (state.linuxBackend === "hyprland" && state.shortcutActionRegistered)
    return t("settings.providers.snapshot.status.useShortcut");
  if (state.shortcutRegistered)
    return state.shortcutLabel
      ? t("settings.providers.snapshot.status.ready")
      : t("settings.providers.snapshot.status.shortcutSaved");
  return t("settings.providers.snapshot.status.finishSetup");
}

export function snapShotShortcutStatus(
  state: DesktopSnapShotState | null,
  t: TranslateFn = createTranslator("en"),
): string | null {
  if (!state) return null;
  if (state.linuxBackend === "hyprland") return state.shortcutMessage;
  if (state.shortcutPending) return t("settings.providers.snapshot.shortcutStatus.approve");
  if (state.shortcutRegistered)
    return state.mode === "portal" ? null : t("settings.providers.snapshot.shortcutStatus.saved");
  return state.shortcutMessage;
}

export function snapShotSetupButtonLabel(
  state: DesktopSnapShotState | null,
  t: TranslateFn = createTranslator("en"),
): string {
  if (!state) return t("settings.providers.snapshot.setupButton.continue");
  if (captureSetupAccessReady(state)) return t("settings.providers.snapshot.setupButton.manage");
  const desktop = captureSetupDesktopName(state);
  return desktop
    ? t("settings.providers.snapshot.setupButton.setUpDesktop", { desktop })
    : t("settings.providers.snapshot.setupButton.continue");
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
  t: TranslateFn = createTranslator("en"),
): string | undefined {
  if (state?.mode !== "portal" || state.linuxFeedbackAvailable) return undefined;
  if (state.linuxBackend === "hyprland")
    return state.hyprlandHelper?.status === "ready"
      ? t("settings.providers.snapshot.feedback.unavailableDesktop")
      : t("settings.providers.snapshot.feedback.installHelper");
  if (state.linuxBackend === "niri")
    return t("settings.providers.snapshot.feedback.unavailableNiri");
  if (state.linuxBackend === "kde")
    return state.kdeHelper?.status === "ready"
      ? t("settings.providers.snapshot.feedback.unavailableDesktop")
      : t("settings.providers.snapshot.feedback.installHelper");
  return state.linuxBackend === "gnome-extension"
    ? t("settings.providers.snapshot.feedback.updateGnome")
    : captureSetupBackend(state) === "gnome"
      ? t("settings.providers.snapshot.feedback.finishExtension")
      : t("settings.providers.snapshot.feedback.unavailableDesktop");
}

export function snapShotDescription(
  state: DesktopSnapShotState | null,
  t: TranslateFn = createTranslator("en"),
): string {
  return state?.mode === "portal" && captureSetupBackend(state) === "picker"
    ? t("settings.providers.snapshot.description.picker")
    : t("settings.providers.snapshot.description.default");
}

export function snapShotAccessibilityUnavailableMessage(
  state: DesktopSnapShotState | null,
  t: TranslateFn = createTranslator("en"),
): string | undefined {
  if (state?.mode !== "portal") return undefined;
  if (state.linuxBackend === "picker" || state.linuxBackend === "screenshot-portal")
    return t("settings.providers.snapshot.accessibility.screenshotOnly");
  return undefined;
}

export function snapShotUnavailableMessage(
  hasBridge: boolean,
  t: TranslateFn = createTranslator("en"),
): string | undefined {
  if (hasBridge) return undefined;
  return typeof window !== "undefined" && window.desktopBridge
    ? t("settings.providers.snapshot.unavailable.updateDesktop")
    : t("settings.providers.snapshot.unavailable.desktopOnly");
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

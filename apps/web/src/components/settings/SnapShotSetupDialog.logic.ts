import type { DesktopSnapShotState } from "@t3tools/contracts";

export type CaptureSetupStep = "access" | "shortcut";

export function captureSetupDesktopName(state: DesktopSnapShotState): string | undefined {
  if (state.mode !== "portal") return undefined;
  const desktop = state.linuxDesktop ?? captureSetupBackend(state);
  switch (desktop) {
    case "gnome":
      return "GNOME";
    case "kde":
      return "KDE Plasma";
    case "niri":
      return "Niri";
    case "hyprland":
      return "Hyprland";
    default:
      return undefined;
  }
}

export function captureSetupBackend(state: DesktopSnapShotState) {
  if (state.mode !== "portal") return "direct";
  if (state.linuxBackend === "niri") return "niri";
  if (state.linuxBackend === "kde") return "kde";
  if (state.linuxBackend === "hyprland") return "hyprland";
  if (state.linuxBackend === "screenshot-portal") return "portal";
  if (state.linuxBackend === "picker" && state.gnomeExtension?.status === "unsupported")
    return "picker";
  if (state.linuxBackend === "gnome-extension" || state.gnomeExtension) return "gnome";
  return "picker";
}

export function captureSetupAccessReady(state: DesktopSnapShotState): boolean {
  if (state.mode === "unavailable" || state.message) return false;
  if (captureSetupBackend(state) === "gnome")
    return state.gnomeExtension?.status === "enabled" && state.linuxBackend === "gnome-extension";
  if (captureSetupBackend(state) === "kde") return state.kdeHelper?.status === "ready";
  if (captureSetupBackend(state) === "hyprland") return state.hyprlandHelper?.status === "ready";
  return true;
}

export function captureSetupMacPermissionsReady(
  state: DesktopSnapShotState,
  includeAccessibility: boolean,
): boolean {
  const permissions = state.macPermissions;
  if (!permissions) return true;
  return permissions.screenRecording && (!includeAccessibility || permissions.accessibility);
}

export function captureSetupCheckMessage(state: DesktopSnapShotState): string {
  const backend = captureSetupBackend(state);
  const gnome = backend === "gnome";
  if (
    state.message ||
    (gnome && state.gnomeExtension?.status === "error") ||
    (backend === "kde" && state.kdeHelper?.status === "error") ||
    (backend === "hyprland" && state.hyprlandHelper?.status === "error")
  )
    return "Still unable to check access. See Advanced for help.";
  if (captureSetupBackend(state) === "picker") return "Ready. You'll choose a window each time.";
  if (gnome && state.gnomeExtension?.status === "restart-required")
    return "Still waiting for you to sign out and back in.";
  return captureSetupAccessReady(state)
    ? "Ready. Continue to choose your shortcut."
    : "Not ready yet. Finish the step above.";
}

export function captureSetupShortcutReady(state: DesktopSnapShotState, unsaved: boolean): boolean {
  if (unsaved || !captureSetupAccessReady(state)) return false;
  if (state.linuxBackend === "hyprland") return Boolean(state.shortcutActionRegistered);
  return state.linuxBackend === "niri"
    ? Boolean(state.shortcutBinding)
    : state.shortcutRegistered || Boolean(state.shortcutPending);
}

export function captureSetupInitialStep(
  state: DesktopSnapShotState,
  requested: CaptureSetupStep | "resume" = "resume",
): CaptureSetupStep {
  if (!captureSetupAccessReady(state)) return "access";
  if (requested === "resume") {
    // A disabled native backend hasn't checked system permissions yet. A picker
    // still needs its explanation; neither is proof of active-window access.
    if (
      (state.mode === "direct" && !state.shortcutRegistered) ||
      captureSetupBackend(state) === "picker"
    )
      return "access";
    return "shortcut";
  }
  return requested;
}

export function captureSetupShouldDisableOnClose(wasEnabled: boolean, completed: boolean): boolean {
  return !wasEnabled && !completed;
}

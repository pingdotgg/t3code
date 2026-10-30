import * as Electron from "electron";

import type { MacPermission } from "./MacPermission.ts";

/** TCC status for the panes a renderer can check; Full Disk Access has no API and is probed by callers. */
export function isMacPermissionGranted(permission: Exclude<MacPermission, "full-disk-access">) {
  return permission === "accessibility"
    ? Electron.systemPreferences.isTrustedAccessibilityClient(false)
    : Electron.systemPreferences.getMediaAccessStatus("screen") === "granted";
}

/**
 * Triggers the system prompt that adds T3 Code to the pane's list. Accessibility
 * prompts through the trust check; Screen Recording prompts on first capture.
 */
export async function requestMacPermission(permission: Exclude<MacPermission, "full-disk-access">) {
  if (permission === "accessibility") {
    Electron.systemPreferences.isTrustedAccessibilityClient(true);
    return;
  }
  if (Electron.systemPreferences.getMediaAccessStatus("screen") !== "not-determined") return;
  try {
    await Electron.desktopCapturer.getSources({
      types: ["screen"],
      thumbnailSize: { width: 1, height: 1 },
    });
  } catch {
    // A denied probe leaves the status for the caller to read.
  }
}

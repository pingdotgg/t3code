import * as Electron from "electron";

const WINDOW_ANIMATIONS_DISABLED = "wm-window-animations-disabled";

/** Show capture feedback without Aura's extra 200 ms fade/scale on transparent windows. */
export function showWindowsCaptureOverlay(window: Electron.BaseWindow): void {
  // Chromium reads this switch synchronously inside Show(). Restore it before returning
  // so other windows and CSS animations keep their normal behavior.
  const alreadyDisabled = Electron.app.commandLine.hasSwitch(WINDOW_ANIMATIONS_DISABLED);
  if (!alreadyDisabled) Electron.app.commandLine.appendSwitch(WINDOW_ANIMATIONS_DISABLED);
  try {
    window.showInactive();
  } finally {
    if (!alreadyDisabled) Electron.app.commandLine.removeSwitch(WINDOW_ANIMATIONS_DISABLED);
  }
}

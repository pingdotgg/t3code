import * as Electron from "electron";

const WINDOW_ANIMATIONS_DISABLED = "wm-window-animations-disabled";

/** Show capture feedback without Aura's extra 200 ms fade/scale on transparent windows. */
export function showWindowsCaptureOverlay(window: Electron.BaseWindow): void {
  // Show() reads the switch synchronously; restore it before other windows or animations can be affected.
  const alreadyDisabled = Electron.app.commandLine.hasSwitch(WINDOW_ANIMATIONS_DISABLED);
  if (!alreadyDisabled) Electron.app.commandLine.appendSwitch(WINDOW_ANIMATIONS_DISABLED);
  try {
    window.showInactive();
  } finally {
    if (!alreadyDisabled) Electron.app.commandLine.removeSwitch(WINDOW_ANIMATIONS_DISABLED);
  }
}

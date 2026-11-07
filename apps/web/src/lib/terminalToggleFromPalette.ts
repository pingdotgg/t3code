import { dispatchMenuAction } from "../shortcuts/dispatcher";

let pendingPaletteToggle = false;

/** Runs the chat's terminal.toggle handler after the palette's focus trap closes. */
export function queueTerminalToggleFromPalette() {
  pendingPaletteToggle = true;
}

/** Runs at the palette's focus restoration milestone. Returns true when it handled focus. */
export function restoreTerminalToggleFromPalette(): boolean {
  if (!pendingPaletteToggle) return false;
  pendingPaletteToggle = false;
  dispatchMenuAction("terminal.toggle");
  return true;
}

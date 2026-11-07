import { executeCommand } from "../commands/registry";

let pendingPaletteFocusUrl = false;

/** Focuses the preview URL after the palette's focus trap closes. */
export function queuePreviewFocusUrlFromPalette() {
  pendingPaletteFocusUrl = true;
}

/** Runs at the palette's focus restoration milestone. Returns true when it handled focus. */
export function restorePreviewFocusUrlFromPalette(): boolean {
  if (!pendingPaletteFocusUrl) return false;
  pendingPaletteFocusUrl = false;
  executeCommand("preview.focusUrl", { source: "palette" });
  return true;
}

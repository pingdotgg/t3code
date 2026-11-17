import { openLayerMatches } from "./openLayers";

const MODAL_DIALOG_SELECTOR = [
  "[data-app-modal]",
  '[data-slot="dialog-popup"][data-open]',
  '[data-slot="alert-dialog-popup"][data-open]',
].join(",");

/**
 * Whether a modal dialog or alert dialog owns the keyboard. Window-level
 * shortcuts (layout keys, tab and panel toggles, the hold menu) yield to it so
 * nothing moves behind the backdrop and the dialog keeps its own Escape.
 */
export function isModalDialogOpen(): boolean {
  return openLayerMatches(MODAL_DIALOG_SELECTOR);
}

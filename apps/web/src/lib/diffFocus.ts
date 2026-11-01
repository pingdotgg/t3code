import { isEditableFocused } from "./editableFocus";

export function isDiffFocused(): boolean {
  const activeElement = document.activeElement;
  if (!(activeElement instanceof HTMLElement) || !activeElement.isConnected) return false;
  return activeElement.closest("[data-diff-panel]") !== null && !isEditableFocused();
}

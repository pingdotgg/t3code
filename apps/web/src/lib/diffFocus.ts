import { isEditableFocused } from "./editableFocus";

/** Focus anywhere in the panel showing the diff, its header and tabs included, outside text fields. */
export function diffPanelHasFocus(panel: Element): boolean {
  const activeElement = document.activeElement;
  if (activeElement === null || isEditableFocused()) return false;
  const area = panel.closest("[data-workspace-area]") ?? panel;
  // Hidden tabs stay mounted, so a panel's area can hold diffs that are not on screen.
  return area.contains(activeElement) && panel.checkVisibility({ visibilityProperty: true });
}

export function isDiffFocused(): boolean {
  return Array.from(document.querySelectorAll("[data-diff-panel]")).some(diffPanelHasFocus);
}

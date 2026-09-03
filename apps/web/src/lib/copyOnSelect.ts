/**
 * Copy-on-select helpers (Herdr-style: selecting text copies it and shows a
 * toast). The DOM side owns reading `window.getSelection()`; the terminal
 * side owns reading the canvas surface. Both sides share the emptiness and
 * gesture guards here so neither path copies stale or empty selections.
 *
 * Used by `useCopyOnSelect` (chat timeline) and `ThreadTerminalDrawer`.
 */

/** Interactive elements whose mouseup must never trigger an auto-copy. */
export const COPY_ON_SELECT_INTERACTIVE_SELECTOR =
  "button, a, input, textarea, select, [role=button], [contenteditable], [data-no-copy-on-select]";

/**
 * Herdr copies on mouse release after a drag or double-click. Only the
 * primary (left) button without clipboard-conflicting modifiers qualifies:
 * Ctrl/Cmd/Alt-clicks can activate links or OS gestures, where copying the
 * pre-existing selection would clobber the clipboard with stale text.
 */
export function shouldAutoCopyOnMouseUp(event: MouseEvent): boolean {
  if (event.button !== 0) return false;
  if (event.ctrlKey || event.metaKey || event.altKey) return false;
  return true;
}

/** True when the mouseup landed on (or inside) an interactive element. */
export function isCopyOnSelectInteractiveTarget(target: EventTarget | null): boolean {
  if (target === null || typeof Element === "undefined") return false;
  if (!(target instanceof Element)) return false;
  return target.closest(COPY_ON_SELECT_INTERACTIVE_SELECTOR) !== null;
}

/**
 * Terminal selections use `\r\n` line endings and can carry blank leading or
 * trailing lines from block drag-selects. Returns the copyable text, or null
 * when there is nothing worth copying.
 */
export function normalizeTerminalSelectionText(text: string): string | null {
  const normalized = text.replace(/\r\n/g, "\n").replace(/^\n+|\n+$/g, "");
  return normalized.length > 0 ? text : null;
}

function nodeInEditable(node: Node | null): boolean {
  let current: Node | null = node;
  while (current !== null) {
    if (current.nodeType === 1) {
      const element = current as Element;
      if (element.closest(COPY_ON_SELECT_INTERACTIVE_SELECTOR) !== null) return true;
    }
    current = current.parentNode;
  }
  return false;
}

/**
 * Returns the selected text when it is worth auto-copying, otherwise null.
 * Skips collapsed/multi-range selections, whitespace-only text, selections
 * rooted in editable or interactive elements, and (when given) selections
 * outside `container`.
 */
export function getCopyableDomSelectionText(
  selection: Selection | null,
  container?: HTMLElement | null,
): string | null {
  if (selection === null || selection.isCollapsed || selection.rangeCount !== 1) return null;
  const text = selection.toString();
  if (text.trim().length === 0) return null;
  const range = selection.getRangeAt(0);
  if (nodeInEditable(range.startContainer) || nodeInEditable(range.endContainer)) return null;
  if (container && (!container.contains(range.startContainer) || !container.contains(range.endContainer))) {
    return null;
  }
  return text;
}

/**
 * Copy-on-select helpers (Herdr-style: selecting text copies it and shows a
 * toast). The DOM side owns reading `window.getSelection()`; the terminal
 * side owns reading the canvas surface. Both sides share the emptiness and
 * gesture guards here so neither path copies stale or empty selections.
 *
 * Used by `useCopyOnSelect` (chat timeline) and `ThreadTerminalDrawer`.
 */

/**
 * Subtrees whose text must never auto-copy: form fields and explicitly
 * opted-out regions. Links, buttons, and other clickable chips are
 * intentionally NOT excluded — chat is full of selectable controls, and a
 * drag across them is still a real selection. Clicks on those controls
 * without a drag are filtered by gesture-identity comparison instead.
 */
export const COPY_ON_SELECT_EDITABLE_SELECTOR =
  "input, textarea, select, [contenteditable], [data-no-copy-on-select]";

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

/** True when the target is inside an editable or opted-out element. */
export function isCopyOnSelectEditableTarget(target: EventTarget | null): boolean {
  if (target === null || typeof Element === "undefined") return false;
  if (!(target instanceof Element)) return false;
  return target.closest(COPY_ON_SELECT_EDITABLE_SELECTOR) !== null;
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
      if (element.closest(COPY_ON_SELECT_EDITABLE_SELECTOR) !== null) return true;
    }
    current = current.parentNode;
  }
  return false;
}

/**
 * Returns the selected text when it is worth auto-copying, otherwise null.
 * Skips collapsed/multi-range selections, whitespace-only text, selections
 * rooted in editable elements, and (when given) selections outside
 * `container`. Selections inside links, buttons, and other clickable chips
 * are allowed: only form fields opt out.
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

/**
 * Identity of a DOM selection at one moment of a mouse gesture. Compared
 * between mousedown and mouseup so a plain click over an existing selection
 * never re-copies it: only a gesture that created or changed the selection
 * may trigger an auto-copy.
 */
export type DomSelectionSnapshot = {
  text: string;
  anchorNode: Node | null;
  anchorOffset: number;
  focusNode: Node | null;
  focusOffset: number;
} | null;

export function snapshotDomSelection(selection: Selection | null): DomSelectionSnapshot {
  if (selection === null || selection.isCollapsed) return null;
  return {
    text: selection.toString(),
    anchorNode: selection.anchorNode,
    anchorOffset: selection.anchorOffset,
    focusNode: selection.focusNode,
    focusOffset: selection.focusOffset,
  };
}

export function sameDomSelectionSnapshot(
  before: DomSelectionSnapshot,
  after: DomSelectionSnapshot,
): boolean {
  if (before === null || after === null) return before === after;
  return (
    before.text === after.text &&
    before.anchorNode === after.anchorNode &&
    before.anchorOffset === after.anchorOffset &&
    before.focusNode === after.focusNode &&
    before.focusOffset === after.focusOffset
  );
}

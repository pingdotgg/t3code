import { SELECTION_MULTI_CLICK_INTERVAL_MS } from "./selectionActions";

// Links, buttons and contenteditable="false" chips stay copyable; editable or opted-out content does not.
const EXCLUDED_SELECTOR =
  'input, textarea, select, [contenteditable]:not([contenteditable="false" i]), [data-no-copy-on-select]';

/** Returns the selection's text if it lies wholly in `container` and touches no excluded subtree. */
export function readCopyableSelection(
  selection: Selection | null,
  container: HTMLElement,
): string | null {
  if (!selection || selection.isCollapsed || selection.rangeCount !== 1) return null;
  const range = selection.getRangeAt(0);
  if (!container.contains(range.startContainer) || !container.contains(range.endContainer)) {
    return null;
  }
  for (const excluded of container.querySelectorAll(EXCLUDED_SELECTOR)) {
    if (range.intersectsNode(excluded)) return null;
  }
  const text = selection.toString();
  return text.trim() ? text : null;
}

type SelectionSnapshot = readonly [Node | null, number, Node | null, number] | null;

function snapshotSelection(selection: Selection | null): SelectionSnapshot {
  if (!selection || selection.isCollapsed) return null;
  return [selection.anchorNode, selection.anchorOffset, selection.focusNode, selection.focusOffset];
}

function sameSnapshot(a: SelectionSnapshot, b: SelectionSnapshot): boolean {
  return a === b || (a !== null && b !== null && a.every((part, index) => part === b[index]));
}

function isPlainPrimaryClick(event: MouseEvent): boolean {
  return event.button === 0 && !event.ctrlKey && !event.metaKey && !event.altKey;
}

/**
 * Calls `copy` when a mouse gesture that starts in `container` leaves a new copyable selection.
 * The release may land anywhere. Double and triple clicks copy once, after the click sequence.
 */
export function observeCopyOnSelect(
  container: HTMLElement,
  copy: (text: string) => void,
): () => void {
  const view = container.ownerDocument.defaultView!;
  let sequenceStart: SelectionSnapshot = null;
  let armed = false;
  let timer: number | null = null;

  const cancelPending = () => {
    if (timer !== null) view.clearTimeout(timer);
    timer = null;
  };
  const copyCurrentSelection = () => {
    timer = null;
    const text = readCopyableSelection(view.getSelection(), container);
    if (text !== null) copy(text);
  };
  const onMouseDown = (event: MouseEvent) => {
    cancelPending();
    // Later clicks of a multi-click compare against the selection before the first click.
    if (event.detail <= 1) sequenceStart = snapshotSelection(view.getSelection());
    const target = event.target;
    armed =
      isPlainPrimaryClick(event) &&
      target instanceof Node &&
      container.contains(target) &&
      !(target instanceof Element && target.closest(EXCLUDED_SELECTOR));
  };
  const onMouseUp = (event: MouseEvent) => {
    if (!armed) return;
    armed = false;
    if (!isPlainPrimaryClick(event)) return;
    // A click that left the selection as it was must not overwrite the clipboard.
    if (sameSnapshot(sequenceStart, snapshotSelection(view.getSelection()))) return;
    if (event.detail >= 2) {
      timer = view.setTimeout(copyCurrentSelection, SELECTION_MULTI_CLICK_INTERVAL_MS);
    } else {
      copyCurrentSelection();
    }
  };

  view.addEventListener("mousedown", onMouseDown, true);
  view.addEventListener("mouseup", onMouseUp, true);
  return () => {
    cancelPending();
    view.removeEventListener("mousedown", onMouseDown, true);
    view.removeEventListener("mouseup", onMouseUp, true);
  };
}

/**
 * Writes through the async Clipboard API only. The execCommand fallback would move focus and
 * the DOM selection, which breaks the selection being copied and the terminal's IME input.
 * Failures stay silent and leave the text retryable; a write already in flight is not repeated.
 */
export function createSelectionCopier(onCopied: () => void) {
  let pendingText: string | null = null;
  return async (text: string): Promise<boolean> => {
    if (text === pendingText) return false;
    pendingText = text;
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      return false;
    } finally {
      if (pendingText === text) pendingText = null;
    }
    onCopied();
    return true;
  };
}

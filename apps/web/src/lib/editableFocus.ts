const EDITABLE_SELECTOR = [
  "input",
  "textarea",
  "select",
  '[contenteditable=""]',
  '[contenteditable="true"]',
  '[contenteditable="plaintext-only"]',
  '[role="textbox"]',
].join(",");

/**
 * Whether a text-editing element owns the keyboard. Shortcuts that share
 * their chord with native editing (mod+z) must yield when this is true.
 */
export function isEditableFocused(target: EventTarget | null = document.activeElement): boolean {
  return target instanceof Element && target.closest(EDITABLE_SELECTOR) !== null;
}

const editableUndoHistory = new WeakMap<Element, () => boolean>();

/** Lets an editor report its actual undo stack; native fields keep their keyboard. */
export function registerEditableUndoHistory(element: Element, canUndo: () => boolean) {
  editableUndoHistory.set(element, canUndo);
  return () => {
    editableUndoHistory.delete(element);
  };
}

/** An empty composer yields to thread undo only when its editor history is empty. */
export function editableOwnsUndo(target: EventTarget | null = document.activeElement): boolean {
  if (!(target instanceof Element)) return false;
  const element = target.closest(EDITABLE_SELECTOR);
  if (!element) return false;
  const canUndo = editableUndoHistory.get(element);
  // Native fields do not expose their undo stack, so preserve their shortcut.
  if (!canUndo) return true;
  return canUndo() || (element.textContent ?? "").length > 0;
}

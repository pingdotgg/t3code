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

/**
 * Whether the focused editable has content for native undo to act on. An
 * empty composer has nothing to undo, so mod+z can fall through to the app.
 */
export function editableOwnsUndo(target: EventTarget | null = document.activeElement): boolean {
  if (!isEditableFocused(target)) return false;
  const element = (target as Element).closest(EDITABLE_SELECTOR);
  if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
    return element.value.length > 0;
  }
  return (element?.textContent ?? "").length > 0;
}

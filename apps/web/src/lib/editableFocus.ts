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

const lastEditableInputAt = new WeakMap<Element, number>();
if (typeof window !== "undefined") {
  window.addEventListener(
    "input",
    (event) => {
      const element = (event.target as Element | null)?.closest?.(EDITABLE_SELECTOR);
      if (element) lastEditableInputAt.set(element, Date.now());
    },
    true,
  );
}

/**
 * Whether the focused editable has native undo history worth keeping: it holds
 * text, or the user edited it after `since` (so it may have just been emptied
 * and mod+z should bring the text back). An untouched empty composer has
 * nothing to undo, so mod+z can fall through to the app.
 */
export function editableOwnsUndo(
  target: EventTarget | null = document.activeElement,
  since = 0,
): boolean {
  if (!isEditableFocused(target)) return false;
  const element = (target as Element).closest(EDITABLE_SELECTOR);
  if (element && (lastEditableInputAt.get(element) ?? 0) > since) return true;
  if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
    return element.value.length > 0;
  }
  return (element?.textContent ?? "").length > 0;
}

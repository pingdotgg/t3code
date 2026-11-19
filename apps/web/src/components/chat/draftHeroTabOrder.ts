const PROJECT_ROW_SELECTOR = '[data-draft-hero-projects] [role="listitem"] > button:first-child';
const TABBABLE_SELECTOR =
  'button:not(:disabled), a[href], input:not(:disabled), textarea:not(:disabled), select:not(:disabled), [contenteditable="true"], [tabindex]';

function isShown(element: HTMLElement) {
  return element.getClientRects().length > 0 && !element.closest("[inert]");
}

function projectRows(overlay: HTMLElement) {
  return Array.from(overlay.querySelectorAll<HTMLButtonElement>(PROJECT_ROW_SELECTOR)).filter(
    (row) => !row.disabled && isShown(row),
  );
}

/** What a plain Tab from the message box reached before the project rows took that stop. */
function tabStopAfterEditor(overlay: HTMLElement, editor: HTMLElement) {
  return Array.from(overlay.querySelectorAll<HTMLElement>(TABBABLE_SELECTOR)).find(
    (element) =>
      element.tabIndex >= 0 &&
      !editor.contains(element) &&
      editor.compareDocumentPosition(element) & Node.DOCUMENT_POSITION_FOLLOWING &&
      isShown(element),
  );
}

/**
 * An empty draft's Tab order runs message box → project picker → the box's next control (send),
 * though the picker sits above the box. Returns whether it moved focus.
 */
export function routeDraftHeroTab(
  event: Pick<KeyboardEvent, "key" | "shiftKey" | "altKey" | "ctrlKey" | "metaKey" | "target">,
  overlay: HTMLElement,
  focusEditor: () => void,
): boolean {
  if (event.key !== "Tab" || event.altKey || event.ctrlKey || event.metaKey) return false;
  const target = event.target;
  if (!(target instanceof HTMLElement)) return false;
  const rows = projectRows(overlay);
  if (rows.length === 0) return false;
  const editor = overlay.querySelector<HTMLElement>(
    '[data-chat-composer-stack] [contenteditable="true"]',
  );
  if (!editor) return false;
  const focusPicker = () =>
    (rows.find((row) => row.getAttribute("aria-current") === "true") ?? rows[0])!.focus();

  if (editor.contains(target)) {
    if (event.shiftKey) return false;
    focusPicker();
    return true;
  }
  if (target.closest("[data-draft-hero-projects]")) {
    const next = event.shiftKey ? undefined : tabStopAfterEditor(overlay, editor);
    if (next) next.focus();
    else focusEditor();
    return true;
  }
  if (event.shiftKey && target === tabStopAfterEditor(overlay, editor)) {
    focusPicker();
    return true;
  }
  return false;
}

/** Up and down move between the picker's rows, now that Tab leaves the picker. */
export function moveDraftHeroRowFocus(
  event: Pick<KeyboardEvent, "key" | "altKey" | "ctrlKey" | "metaKey" | "shiftKey" | "target">,
  list: HTMLElement,
): boolean {
  if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return false;
  if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return false;
  const rows = Array.from(
    list.querySelectorAll<HTMLButtonElement>('[role="listitem"] > button:first-child'),
  ).filter((row) => !row.disabled && isShown(row));
  const index = rows.findIndex((row) => row === event.target);
  if (index === -1) return false;
  rows[(index + (event.key === "ArrowDown" ? 1 : -1) + rows.length) % rows.length]!.focus();
  return true;
}

import type { KeyboardEvent as ReactKeyboardEvent } from "react";

const PROJECT_ROW_SELECTOR = '[data-draft-hero-projects] [role="listitem"] > button:first-child';
const TABBABLE_SELECTOR =
  'button:not(:disabled), a[href], input:not(:disabled), textarea:not(:disabled), select:not(:disabled), [contenteditable="true"], [tabindex]';

function isShown(element: HTMLElement) {
  return element.getClientRects().length > 0 && !element.closest("[inert]");
}

function projectRows(overlay: HTMLElement) {
  return Array.from(overlay.querySelectorAll<HTMLButtonElement>(PROJECT_ROW_SELECTOR)).filter(
    (row) => row.tabIndex < 0 && !row.disabled && isShown(row),
  );
}

function tabStopAfterEditor(overlay: HTMLElement, editor: HTMLElement) {
  return Array.from(overlay.querySelectorAll<HTMLElement>(TABBABLE_SELECTOR)).find(
    (element) =>
      element.tabIndex >= 0 &&
      !editor.contains(element) &&
      editor.compareDocumentPosition(element) & Node.DOCUMENT_POSITION_FOLLOWING &&
      isShown(element),
  );
}

function routeDraftHeroTab(
  event: Pick<
    KeyboardEvent,
    "key" | "shiftKey" | "altKey" | "ctrlKey" | "metaKey" | "isComposing" | "target"
  >,
  overlay: HTMLElement,
): boolean {
  if (event.key !== "Tab" || event.altKey || event.ctrlKey || event.metaKey || event.isComposing) {
    return false;
  }
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
    else editor.focus();
    return true;
  }
  if (event.shiftKey && target === tabStopAfterEditor(overlay, editor)) {
    focusPicker();
    return true;
  }
  return false;
}

function moveDraftHeroRowFocus(
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

export function onDraftHeroKeyDown(event: ReactKeyboardEvent<HTMLElement>) {
  if (!event.defaultPrevented && routeDraftHeroTab(event.nativeEvent, event.currentTarget)) {
    event.preventDefault();
  }
}

export function onDraftHeroListKeyDown(event: ReactKeyboardEvent<HTMLElement>) {
  if (moveDraftHeroRowFocus(event.nativeEvent, event.currentTarget)) event.preventDefault();
}

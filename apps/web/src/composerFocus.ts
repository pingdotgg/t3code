export const COMPOSER_FOCUS_REQUEST_EVENT = "t3code:composer-focus-request";

export function requestComposerFocus(target: Window = window): void {
  target.dispatchEvent(new Event(COMPOSER_FOCUS_REQUEST_EVENT));
}

export function isComposerFocusShortcut(
  event: Pick<
    globalThis.KeyboardEvent,
    "altKey" | "ctrlKey" | "defaultPrevented" | "key" | "metaKey" | "repeat" | "shiftKey"
  >,
): boolean {
  if (event.defaultPrevented || event.repeat) return false;
  if (event.shiftKey || event.altKey) return false;
  if (!(event.metaKey || event.ctrlKey)) return false;
  return event.key.toLowerCase() === "l";
}

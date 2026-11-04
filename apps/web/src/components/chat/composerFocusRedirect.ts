import { surfaceShortcutKey } from "~/lib/surfaceShortcutKey";

export const TYPE_TO_FOCUS_EDITABLE_SELECTOR = [
  "input",
  "textarea",
  "select",
  '[contenteditable="true"]',
  '[contenteditable="plaintext-only"]',
  '[role="textbox"]',
].join(",");
const TYPE_TO_FOCUS_INTERACTIVE_SELECTOR = [
  "button",
  "a[href]",
  "summary",
  '[role="application"]',
  '[role="button"]',
  '[role="checkbox"]',
  '[role="menuitem"]',
  '[role="option"]',
  '[role="radio"]',
  '[role="switch"]',
  '[role="tab"]',
].join(",");
// Closed popups can stay mounted; match only open or closing layers.
export const TYPE_TO_FOCUS_FLOATING_LAYER_SELECTOR = [
  '[role="dialog"][aria-modal="true"]',
  '[data-slot="alert-dialog-popup"]:is([data-open],[data-ending-style])',
  '[data-slot="command-dialog-popup"]:is([data-open],[data-ending-style])',
  '[data-slot="dialog-popup"]:is([data-open],[data-ending-style])',
  '[data-slot="sheet-popup"]:is([data-open],[data-ending-style])',
  '[data-slot="sidebar"][data-mobile="true"]:is([data-open],[data-ending-style])',
  '[data-slot="menu-popup"]:is([data-open],[data-ending-style])',
  '[data-slot="select-popup"]:is([data-open],[data-ending-style])',
  '[data-slot="popover-popup"]:is([data-open],[data-ending-style])',
  '[data-slot="combobox-popup"]:is([data-open],[data-ending-style])',
  '[data-slot="autocomplete-popup"]:is([data-open],[data-ending-style])',
].join(",");

export function eventPathContainsSelector(event: Event, selector: string): boolean {
  const path = event.composedPath();
  if (path.length === 0 && event.target) {
    path.push(event.target);
  }
  return path.some((target) => target instanceof Element && target.closest(selector));
}

const SECRET_REQUEST_SELECTOR = '[data-v2-item-type="secret_request"]';
const SURFACE_LAUNCHER_KEYS_ATTRIBUTE = "data-surface-launcher-keys";

// The right-panel launcher registers its own window capture listener when it
// mounts. When the panel opens after page load that listener runs after ours,
// so we must leave its letters alone or the composer takes them first.
function isSurfaceLauncherKey(event: KeyboardEvent): boolean {
  const launcherKeys = document
    .querySelector(`[${SURFACE_LAUNCHER_KEYS_ATTRIBUTE}]`)
    ?.getAttribute(SURFACE_LAUNCHER_KEYS_ATTRIBUTE)
    ?.toLowerCase();
  const key = surfaceShortcutKey(event);
  return key !== null && (launcherKeys?.includes(key) ?? false);
}

/** The side chat in the right panel, which has its own composer. */
export const SIDE_CHAT_PANEL_SELECTOR = "[data-side-chat-panel]";

/**
 * Which composer asks for the input: the lesson's takes only input from outside
 * the side-chat panel, and the side chat's only input from inside it.
 */
export type ComposerInputScope = "lesson" | "side-chat";

export function shouldRedirectInputToComposer(
  event: Event,
  scope: ComposerInputScope = "lesson",
): boolean {
  if (event.defaultPrevented) return false;
  if ((scope === "side-chat") !== eventPathContainsSelector(event, SIDE_CHAT_PANEL_SELECTOR)) {
    return false;
  }
  // Never persist or send secret-request typing through the composer.
  if (eventPathContainsSelector(event, SECRET_REQUEST_SELECTOR)) return false;
  if (eventPathContainsSelector(event, TYPE_TO_FOCUS_EDITABLE_SELECTOR)) return false;
  if (eventPathContainsSelector(event, TYPE_TO_FOCUS_INTERACTIVE_SELECTOR)) return false;
  for (const layer of document.querySelectorAll(TYPE_TO_FOCUS_FLOATING_LAYER_SELECTOR)) {
    // On narrow screens the right panel, and so the side chat, sits in a sheet.
    if (scope === "side-chat" && event.target instanceof Node && layer.contains(event.target)) {
      continue;
    }
    return false;
  }
  return true;
}

export function shouldTypeToFocusComposer(
  event: KeyboardEvent,
  scope: ComposerInputScope = "lesson",
): boolean {
  if (event.isComposing) return false;
  if (event.metaKey || event.ctrlKey || event.altKey) return false;
  if (event.key.length !== 1) return false;
  if (!shouldRedirectInputToComposer(event, scope)) return false;
  if (isSurfaceLauncherKey(event)) return false;

  return true;
}

export function pasteTextToFocusComposer(
  event: ClipboardEvent,
  scope: ComposerInputScope = "lesson",
): string | null {
  if (!event.clipboardData || event.clipboardData.files.length > 0) return null;
  if (!shouldRedirectInputToComposer(event, scope)) return null;
  const text = event.clipboardData.getData("text/plain");
  return text.length > 0 ? text : null;
}

/** Whether `element` is the lesson's composer editor, not the side chat's. */
export function isLessonComposerFocused(element: Element | null): boolean {
  return (
    element?.getAttribute("data-testid") === "composer-editor" &&
    element.closest(SIDE_CHAT_PANEL_SELECTOR) === null
  );
}

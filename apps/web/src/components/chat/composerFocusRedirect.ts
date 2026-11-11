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

function isKeyClaimedInPath(event: KeyboardEvent): boolean {
  if (event.shiftKey) return false;
  const key = event.key.toUpperCase();
  return event
    .composedPath()
    .some(
      (target) =>
        target instanceof Element &&
        (target.getAttribute("aria-keyshortcuts")?.split(/\s+/).includes(key) ?? false),
    );
}

export function shouldRedirectInputToComposer(event: Event): boolean {
  if (event.defaultPrevented) return false;
  // Never persist or send secret-request typing through the composer.
  if (eventPathContainsSelector(event, SECRET_REQUEST_SELECTOR)) return false;
  if (eventPathContainsSelector(event, TYPE_TO_FOCUS_EDITABLE_SELECTOR)) return false;
  if (eventPathContainsSelector(event, TYPE_TO_FOCUS_INTERACTIVE_SELECTOR)) return false;
  if (document.querySelector(TYPE_TO_FOCUS_FLOATING_LAYER_SELECTOR)) return false;
  if (document.querySelector('[data-chat-column-maximized-away="true"]')) return false;
  return true;
}

/**
 * Where a key landed: the composer's answer field, one of an open question's
 * options, some other focused element, or the page when nothing but the
 * question card holds focus.
 */
export type PendingQuestionKeyTarget = "answer" | "option" | "control" | "page";

/**
 * Where a key landed, for an open question's 1-9, Backspace and Enter. Null
 * leaves the key to another field or an open popup.
 */
export function pendingQuestionKeyTarget(event: KeyboardEvent): PendingQuestionKeyTarget | null {
  // Every keystroke typed in the composer passes here, so rule out the rest first.
  if (event.key !== "Enter" && event.key !== "Backspace" && !/^[1-9]$/.test(event.key)) {
    return null;
  }
  if (event.isComposing || event.metaKey || event.ctrlKey || event.altKey) return null;
  if (document.querySelector(TYPE_TO_FOCUS_FLOATING_LAYER_SELECTOR)) return null;
  if (eventPathContainsSelector(event, '[data-testid="composer-editor"]')) return "answer";
  if (eventPathContainsSelector(event, "[data-pending-user-input-option]")) return "option";
  if (eventPathContainsSelector(event, TYPE_TO_FOCUS_EDITABLE_SELECTOR)) return null;
  // Nothing holds focus, or only the question card does, as after clicking its text.
  const onQuestionCard =
    eventPathContainsSelector(event, '[data-chat-composer-top-drawer="true"]') &&
    !eventPathContainsSelector(event, TYPE_TO_FOCUS_INTERACTIVE_SELECTOR);
  return event.target === document.body || onQuestionCard ? "page" : "control";
}

export function shouldTypeToFocusComposer(event: KeyboardEvent): boolean {
  if (event.isComposing) return false;
  if (event.metaKey || event.ctrlKey || event.altKey) return false;
  if (event.key.length !== 1) return false;
  if (!shouldRedirectInputToComposer(event)) return false;
  if (isSurfaceLauncherKey(event)) return false;
  if (isKeyClaimedInPath(event)) return false;

  return true;
}

export function pasteTextToFocusComposer(event: ClipboardEvent): string | null {
  if (!event.clipboardData || event.clipboardData.files.length > 0) return null;
  if (!shouldRedirectInputToComposer(event)) return null;
  const text = event.clipboardData.getData("text/plain");
  return text.length > 0 ? text : null;
}

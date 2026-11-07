import { getClientSettings } from "~/hooks/useSettings";

import type { AssistantCitationSourceAnchor } from "~/lib/assistantTextSelection";
import { readPastedComposerContext } from "../composerInlineTokenPaste";

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

export function shouldRedirectInputToComposer(event: Event): boolean {
  if (event.defaultPrevented) return false;
  // Never persist or send secret-request typing through the composer.
  if (eventPathContainsSelector(event, SECRET_REQUEST_SELECTOR)) return false;
  if (eventPathContainsSelector(event, TYPE_TO_FOCUS_EDITABLE_SELECTOR)) return false;
  if (eventPathContainsSelector(event, TYPE_TO_FOCUS_INTERACTIVE_SELECTOR)) return false;
  if (
    Array.from(document.querySelectorAll(TYPE_TO_FOCUS_FLOATING_LAYER_SELECTOR)).some(
      (layer) =>
        !pendingCitation?.commentInput?.pending ||
        !layer.querySelector("[data-citation-comment-editor]"),
    )
  )
    return false;
  return true;
}

let pendingCitation: AssistantCitationSourceAnchor | undefined;

function citeSelectionInput(event: Event, text: string): boolean {
  if (getClientSettings().typingWithSelection !== "cite") return false;
  const pending = pendingCitation?.commentInput;
  if (
    pending?.pending &&
    pendingCitation?.source.isConnected &&
    window.getSelection()?.isCollapsed
  ) {
    pending.append(text);
    pendingCitation.initialComment = pending.text;
    event.preventDefault();
    event.stopPropagation();
    return true;
  }
  pendingCitation = undefined;
  const toolbar = document.querySelector<HTMLButtonElement>("[data-type-to-cite]:not(:disabled)");
  if (!toolbar) return false;
  const request = new CustomEvent("cite-selection-input", {
    detail: {
      text,
      accept: (anchor: AssistantCitationSourceAnchor) => {
        pendingCitation = anchor;
      },
    },
    cancelable: true,
  });
  toolbar.dispatchEvent(request);
  if (!request.defaultPrevented) return false;
  event.preventDefault();
  event.stopPropagation();
  return true;
}

export function shouldTypeToFocusComposer(event: KeyboardEvent): boolean {
  if (event.isComposing || event.keyCode === 229) return false;
  if (event.metaKey || event.ctrlKey || event.altKey) return false;
  if (event.key.length !== 1) return false;
  if (isSurfaceLauncherKey(event)) return false;
  if (!shouldRedirectInputToComposer(event)) return false;
  if (citeSelectionInput(event, event.key)) return false;

  return true;
}

export function pasteTextToFocusComposer(event: ClipboardEvent): string | null {
  if (!event.clipboardData || event.clipboardData.files.length > 0) return null;
  const hasContext = (readPastedComposerContext(event.clipboardData)?.records.length ?? 0) > 0;
  const text = event.clipboardData.getData("text/plain");
  if (!shouldRedirectInputToComposer(event)) return null;
  if (!hasContext && text.length > 0 && citeSelectionInput(event, text)) return null;
  return text.length > 0 ? text : null;
}

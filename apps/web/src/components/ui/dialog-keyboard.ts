import type * as React from "react";

// Elements that own Enter: new lines, link navigation and popup pickers.
const ENTER_OWNER_SELECTOR = [
  "textarea",
  "select",
  "a[href]",
  '[contenteditable]:not([contenteditable="false"])',
  '[role="combobox"]',
  '[role="listbox"]',
  '[role="menu"]',
].join(", ");

/**
 * Decides whether an Enter keypress inside a dialog should run its primary action
 * instead of activating the focused element.
 */
function shouldEnterRunDialogAction(event: React.KeyboardEvent<HTMLElement>): boolean {
  // keyCode 229 is the Enter Safari sends right after an IME composition ends.
  if (event.key !== "Enter" || event.nativeEvent.isComposing || event.keyCode === 229) {
    return false;
  }
  // A held Enter that opened the dialog must not also confirm it.
  if (event.repeat || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) {
    return false;
  }
  return !(event.target instanceof Element && event.target.closest(ENTER_OWNER_SELECTOR));
}

/**
 * Runs the popup's primary action when Enter is pressed anywhere in it, as native alerts
 * do. Focus stays where it is, so Space still activates the focused button.
 */
export function runDialogActionOnEnter(
  event: React.KeyboardEvent<HTMLElement>,
  actionSlot: string,
) {
  if (event.defaultPrevented || !shouldEnterRunDialogAction(event)) return;
  const action = event.currentTarget.querySelector<HTMLButtonElement>(
    `[data-slot="${actionSlot}"]:not(:disabled):not([aria-disabled="true"])`,
  );
  if (!action) return;
  event.preventDefault();
  action.click();
}

import type { MouseEvent as ReactMouseEvent } from "react";

const isThumbButton = (event: ReactMouseEvent) => event.button === 3 || event.button === 4;

// A thumb press would otherwise focus the URL bar, which then stops tracking the page.
export function preventThumbButtonFocus(event: ReactMouseEvent) {
  if (isThumbButton(event)) event.preventDefault();
}

// Chromium runs app-router history on a thumb-button mouseup unless it is cancelled.
// Page content that already stepped its own history cancels it first.
export function takeThumbButtonNavigation(
  event: ReactMouseEvent,
  navigate: ((direction: "back" | "forward") => void) | undefined,
) {
  if (!isThumbButton(event) || event.defaultPrevented) return;
  event.preventDefault();
  navigate?.(event.button === 3 ? "back" : "forward");
}

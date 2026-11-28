import type { KeyboardEvent } from "react";

// Base UI commits on blur but not on Enter; refocus so keyboard users stay put.
export function commitNumberFieldOnEnter(event: KeyboardEvent<HTMLInputElement>) {
  if (event.key !== "Enter" || event.nativeEvent.isComposing || event.keyCode === 229) return;
  const input = event.currentTarget;
  input.blur();
  input.focus();
}

import { useSyncExternalStore } from "react";

import { isTerminalFocused } from "../lib/terminalFocus";

function subscribeToTerminalFocus(onStoreChange: () => void): () => void {
  document.addEventListener("focusin", onStoreChange);
  document.addEventListener("focusout", onStoreChange);
  return () => {
    document.removeEventListener("focusin", onStoreChange);
    document.removeEventListener("focusout", onStoreChange);
  };
}

function getServerSnapshot(): boolean {
  return false;
}

/** Reactively tracks whether focus is currently within either terminal surface. */
export function useTerminalFocus(): boolean {
  return useSyncExternalStore(subscribeToTerminalFocus, isTerminalFocused, getServerSnapshot);
}

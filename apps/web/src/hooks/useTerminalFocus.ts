import { useSyncExternalStore } from "react";

import { isTerminalFocused } from "../lib/terminalFocus";

export function subscribeToTerminalFocusChanges(listener: () => void): () => void {
  window.addEventListener("focusin", listener, true);
  window.addEventListener("focusout", listener, true);
  return () => {
    window.removeEventListener("focusin", listener, true);
    window.removeEventListener("focusout", listener, true);
  };
}

export function useTerminalFocus(): boolean {
  return useSyncExternalStore(subscribeToTerminalFocusChanges, isTerminalFocused, () => false);
}

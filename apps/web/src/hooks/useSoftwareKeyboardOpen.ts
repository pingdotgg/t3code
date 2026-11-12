import { useEffect, useSyncExternalStore } from "react";

import { isElectron } from "../env";
import { createSoftwareKeyboardStore, pinShellToKeyboardViewport } from "../lib/softwareKeyboard";

const store = createSoftwareKeyboardStore(
  typeof window === "undefined" ? undefined : window,
  isElectron,
);

function getServerSnapshot() {
  return false;
}

export function useSoftwareKeyboardOpen() {
  return useSyncExternalStore(store.subscribe, store.getSnapshot, getServerSnapshot);
}

export function usePinShellToKeyboardViewport() {
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- keeps <html> pinned to the visual viewport via its listeners while the shell is mounted
  useEffect(() => pinShellToKeyboardViewport(window, isElectron), []);
}

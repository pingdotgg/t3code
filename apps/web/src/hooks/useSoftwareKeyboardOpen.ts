import { useSyncExternalStore } from "react";

import { isElectron } from "../env";
import { createSoftwareKeyboardStore } from "../lib/softwareKeyboard";

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

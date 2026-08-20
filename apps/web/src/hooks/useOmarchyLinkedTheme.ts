import { useSyncExternalStore } from "react";

import { getAvailableOmarchyLinkedTheme, subscribeToOmarchyLinkedTheme } from "../themePalette";

export function useOmarchyLinkedTheme() {
  return useSyncExternalStore(
    subscribeToOmarchyLinkedTheme,
    getAvailableOmarchyLinkedTheme,
    () => null,
  );
}

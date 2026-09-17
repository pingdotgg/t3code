import { useSyncExternalStore } from "react";

import { getCustomThemes, subscribeToCustomThemes } from "../themePalette";

const EMPTY_CUSTOM_THEMES: readonly [] = [];

export function useCustomThemes() {
  return useSyncExternalStore(subscribeToCustomThemes, getCustomThemes, () => EMPTY_CUSTOM_THEMES);
}

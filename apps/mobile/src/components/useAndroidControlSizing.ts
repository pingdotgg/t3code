import { Platform } from "react-native";

import { useAppearancePreferences } from "../features/settings/appearance/AppearancePreferencesProvider";
import { DEFAULT_BASE_FONT_SIZE } from "../lib/appearancePreferences";
import { resolveAndroidControlSizing } from "../lib/androidControlSizing";

/** Shared layouts keep their existing dimensions on iOS. */
export function useAndroidControlSizing() {
  const { appearance } = useAppearancePreferences();
  return resolveAndroidControlSizing(
    Platform.OS === "android" ? appearance.baseFontSize : DEFAULT_BASE_FONT_SIZE,
  );
}

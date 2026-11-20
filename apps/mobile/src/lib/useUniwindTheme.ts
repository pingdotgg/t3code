import { useAppearancePreferences } from "../features/settings/appearance/AppearancePreferencesProvider";
import { getMobileFontFamilies } from "./fontFamilies";
import type { MobileThemeVariables } from "./mobileTheme";

export function useUniwindTheme(): MobileThemeVariables {
  return useAppearancePreferences().themeVariables;
}

export function useThemeFontFamilies() {
  return getMobileFontFamilies(useAppearancePreferences().themeId);
}

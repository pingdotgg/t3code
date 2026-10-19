import { useAppearancePreferences } from "../features/settings/appearance/AppearancePreferencesProvider";
import type { MobileThemeVariables } from "./mobileTheme";

export function useUniwindTheme(): MobileThemeVariables {
  return useAppearancePreferences().themeVariables;
}

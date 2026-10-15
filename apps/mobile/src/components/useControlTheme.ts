import { useAppearancePreferences } from "../features/settings/appearance/AppearancePreferencesProvider";

/** Palette and type size for native controls hosted outside the RN style tree. */
export function useControlTheme() {
  const { themeAppearance, themeVariables, systemColorsActive, appearance } =
    useAppearancePreferences();
  return {
    colorScheme: themeAppearance,
    colors: themeVariables,
    systemColorsActive,
    fontSize: appearance.baseFontSize,
  };
}

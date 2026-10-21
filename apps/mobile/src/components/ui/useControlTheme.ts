import { useAppearancePreferences } from "../../features/settings/appearance/AppearancePreferencesProvider";

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

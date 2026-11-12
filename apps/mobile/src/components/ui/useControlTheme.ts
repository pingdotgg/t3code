import { useAppearancePreferences } from "../../features/settings/appearance/AppearancePreferencesProvider";

export function useControlTheme() {
  const { themeId, themeAppearance, themeVariables, systemColorsActive, appearance } =
    useAppearancePreferences();
  return {
    themeId,
    colorScheme: themeAppearance,
    colors: themeVariables,
    systemColorsActive,
    fontSize: appearance.baseFontSize,
  };
}

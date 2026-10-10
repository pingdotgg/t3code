import { useAppearancePreferences } from "../features/settings/appearance/AppearancePreferencesProvider";
import type { MobileThemeVariables } from "./mobileTheme";

/**
 * Complete JS palette for native and third-party APIs that cannot consume a
 * Uniwind className (React Navigation, native editors, Markdown, SVG gradients,
 * Reanimated worklets). Ordinary React Native rendering must use className.
 *
 * This bridge follows the same single React theme commit as the root
 * ScopedTheme instead of subscribing every consumer to CSS-variable updates.
 */
export function useUniwindTheme(): MobileThemeVariables {
  return useAppearancePreferences().themeVariables;
}

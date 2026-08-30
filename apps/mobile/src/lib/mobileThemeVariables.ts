import defaultThemeVariables from "../../generated-uniwind-default-theme-variables.json";

import {
  DEFAULT_MOBILE_THEME_ID,
  getMobileThemeVariables,
  type MobileThemeAppearance,
  type MobileThemeId,
  type MobileThemeVariables,
} from "./mobileTheme";

const defaults = defaultThemeVariables as Readonly<
  Record<MobileThemeAppearance, MobileThemeVariables>
>;

/**
 * Complete palette for native and third-party APIs that cannot consume a
 * Uniwind className. The standard palette is generated from global.css; custom
 * palettes share the same source that generates their registered CSS themes.
 */
export function getMobileThemeRuntimeVariables(
  themeId: MobileThemeId,
  appearance: MobileThemeAppearance,
): MobileThemeVariables {
  return themeId === DEFAULT_MOBILE_THEME_ID
    ? defaults[appearance]
    : getMobileThemeVariables(themeId, appearance);
}

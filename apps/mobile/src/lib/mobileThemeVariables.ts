import defaultThemeVariables from "../../generated-uniwind-default-theme-variables.json";
import {
  DEFAULT_MOBILE_THEME_ID,
  getMobileThemeVariables,
  themeColorWithAlpha,
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
  platform: string,
): MobileThemeVariables {
  const usesDefaultPalette = themeId === DEFAULT_MOBILE_THEME_ID || themeId === "material-you";
  const variables = usesDefaultPalette
    ? defaults[appearance]
    : getMobileThemeVariables(themeId, appearance);
  if (platform !== "android") return variables;

  // Rounded panes share one opaque frame. The default dark drawer matches the
  // settings body, so use its card tone to keep the rounded edge visible.
  // System colors replace this with their own surfaceContainerHigh afterwards.
  return {
    ...variables,
    "--color-header": themeColorWithAlpha(
      variables[usesDefaultPalette ? "--color-card" : "--color-drawer"],
      1,
    ),
  };
}

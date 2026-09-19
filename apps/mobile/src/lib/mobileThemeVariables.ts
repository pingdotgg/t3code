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
 * Uniwind className. Every palette shares the source that generates its
 * registered CSS theme.
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

  // Desktop separates its near-white default surfaces with a divider. Android's
  // rounded panes need a tonal frame; use the neutral control surface there.
  // Named palettes keep their sidebar frame, and system colors replace it later.
  return {
    ...variables,
    "--color-header": themeColorWithAlpha(
      variables[usesDefaultPalette ? "--color-row-hover" : "--color-drawer"],
      1,
    ),
    "--color-header-foreground": variables["--color-drawer-foreground"],
  };
}

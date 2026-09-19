import defaultThemeVariables from "../../generated-uniwind-default-theme-variables.json";
import {
  DEFAULT_MOBILE_THEME_ID,
  flattenThemeColor,
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
  // Desktop separates its near-white default surfaces with a divider. Android's
  // rounded panes and the iPad sidebar use the same neutral mobile chrome.
  // Named palettes keep their sidebar frame; system colors replace it later.
  const frame = themeColorWithAlpha(
    variables[usesDefaultPalette ? "--color-row-hover" : "--color-drawer"],
    1,
  );
  if (platform === "ios" && usesDefaultPalette) {
    return {
      ...variables,
      "--color-header": frame,
      "--color-header-foreground": variables["--color-drawer-foreground"],
      "--color-drawer": frame,
      "--color-drawer-foreground-muted":
        appearance === "light"
          ? variables["--color-foreground-muted"]
          : variables["--color-drawer-foreground-muted"],
      "--color-thread-hover":
        appearance === "dark"
          ? flattenThemeColor(themeColorWithAlpha(variables["--color-thread-selected"], 0.5), frame)
          : variables["--color-thread-hover"],
    };
  }
  if (platform !== "android") return variables;

  return {
    ...variables,
    "--color-header": frame,
    "--color-header-foreground": variables["--color-drawer-foreground"],
  };
}

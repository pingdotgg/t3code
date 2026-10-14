import type { DesktopLocalThemeState } from "@t3tools/contracts";
import { environmentThemeDefinition } from "./publishedTheme";
import {
  DESKTOP_LOCAL_THEME_ID,
  getStandardThemeColors,
  updateThemeColorFamily,
  setDesktopLocalTheme,
  setDesktopThemeState,
  type ThemeAppearance,
  type ThemeColors,
} from "./themePalette";

/** Native desktops expose appearance and accent, rather than a full app palette. */
export function applyDesktopThemeState(state: DesktopLocalThemeState): boolean {
  const nativeColors = (appearance: ThemeAppearance): ThemeColors => {
    const defaults = getStandardThemeColors(appearance);
    return state.accent === null
      ? defaults
      : updateThemeColorFamily(
          appearance,
          updateThemeColorFamily(appearance, defaults, "accent", state.accent),
          "messageAction",
          state.accent,
        );
  };
  const published =
    state.theme === null
      ? null
      : environmentThemeDefinition({ ...state.theme, id: DESKTOP_LOCAL_THEME_ID });
  const light =
    published?.appearance === "light"
      ? published.colors
      : (published?.variants?.light ?? nativeColors("light"));
  const dark =
    published?.appearance === "dark"
      ? published.colors
      : (published?.variants?.dark ?? nativeColors("dark"));
  const paletteChanged = setDesktopLocalTheme({
    id: DESKTOP_LOCAL_THEME_ID,
    label: "System theme",
    appearance: state.appearance,
    colors: state.appearance === "dark" ? dark : light,
    variants: state.appearance === "dark" ? { light } : { dark },
  });
  const stateChanged = setDesktopThemeState(state);
  return paletteChanged || stateChanged;
}

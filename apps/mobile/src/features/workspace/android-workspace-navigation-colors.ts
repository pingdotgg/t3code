import {
  flattenThemeColor,
  isDarkThemeColor,
  themeColorWithAlpha,
  themeColorWithContrast,
  type MobileThemeVariables,
} from "../../lib/mobileTheme";

// A dark page swallows the native shadow, so the fill alone has to lift the pill off the page
// and off the cards it floats over.
function floatingContainerColor(colors: MobileThemeVariables) {
  const screen = colors["--color-screen"];
  const fill = flattenThemeColor(colors["--color-secondary"], screen);
  if (!isDarkThemeColor(screen)) return fill;
  return themeColorWithContrast(
    fill,
    [screen, flattenThemeColor(colors["--color-grouped-card"], screen)],
    1.25,
  );
}

export function androidWorkspaceNavigationColors(
  colors: MobileThemeVariables,
  rail: boolean,
  floating = false,
) {
  const screen = colors["--color-screen"];
  const header = flattenThemeColor(colors["--color-header"], screen);
  const containerColor = rail
    ? header
    : floating
      ? floatingContainerColor(colors)
      : flattenThemeColor(themeColorWithAlpha(colors["--color-header-foreground"], 0.05), header);
  // The lifted dark pill already took the secondary fill's place, so its indicator lifts further.
  const indicatorColor = themeColorWithContrast(
    floating && isDarkThemeColor(screen)
      ? containerColor
      : flattenThemeColor(colors["--color-secondary"], containerColor),
    containerColor,
    1.5,
  );
  return {
    containerColor,
    indicatorColor,
    selectedColor: themeColorWithContrast(
      flattenThemeColor(colors["--color-secondary-foreground"], indicatorColor),
      [indicatorColor, containerColor],
    ),
    unselectedColor: floating
      ? themeColorWithContrast(
          flattenThemeColor(colors["--color-secondary-foreground"], containerColor),
          containerColor,
        )
      : flattenThemeColor(colors["--color-header-foreground"], containerColor),
  };
}

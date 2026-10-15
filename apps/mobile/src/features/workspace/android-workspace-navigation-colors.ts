import {
  flattenThemeColor,
  themeColorWithContrast,
  type MobileThemeVariables,
} from "../../lib/mobileTheme";

/** Selection colors for the Chats/PRs switch, which sits on the header surface. */
export function androidWorkspaceNavigationColors(colors: MobileThemeVariables) {
  const containerColor = flattenThemeColor(colors["--color-header"], colors["--color-screen"]);
  const indicatorColor = themeColorWithContrast(
    flattenThemeColor(colors["--color-secondary"], containerColor),
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
    unselectedColor: flattenThemeColor(colors["--color-header-foreground"], containerColor),
  };
}

import { flattenThemeColor, type MobileThemeVariables } from "./mobileTheme";

/** Native chip parsers need opaque hex instead of CSS rgba or platform-specific alpha order. */
export function createNativeComposerTheme(theme: MobileThemeVariables) {
  const surface = flattenThemeColor(theme["--color-composer-surface"], theme["--color-screen"]);
  return {
    text: flattenThemeColor(theme["--color-foreground"], surface),
    placeholder: flattenThemeColor(theme["--color-placeholder"], surface),
  };
}

import { flattenThemeColor, type MobileThemeVariables } from "./mobileTheme";

/** Native chip parsers need opaque hex instead of CSS rgba or platform-specific alpha order. */
export function createNativeComposerTheme(theme: MobileThemeVariables) {
  const surface = flattenThemeColor(theme["--color-composer-surface"], theme["--color-screen"]);
  const chipBackground = flattenThemeColor(theme["--color-subtle"], surface);
  const skillBackground = flattenThemeColor(theme["--color-inline-skill-background"], surface);
  return {
    text: flattenThemeColor(theme["--color-foreground"], surface),
    placeholder: flattenThemeColor(theme["--color-placeholder"], surface),
    chipBackground,
    chipBorder: flattenThemeColor(theme["--color-border"], chipBackground),
    chipText: flattenThemeColor(theme["--color-foreground"], chipBackground),
    skillBackground,
    skillBorder: flattenThemeColor(theme["--color-inline-skill-border"], skillBackground),
    skillText: flattenThemeColor(theme["--color-inline-skill-foreground"], skillBackground),
    fileTint: flattenThemeColor(theme["--color-icon-muted"], chipBackground),
  };
}

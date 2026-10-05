import { HTML_RENDER_DEFAULT_FONTS, htmlRenderTheme } from "@t3tools/shared/htmlRender";

import {
  DEFAULT_MOBILE_THEME_ID,
  getMobileThemeColors,
  nativeColors,
  type MobileThemeAppearance,
  type MobileThemeId,
  type MobileThemeVariables,
} from "./mobileTheme";

/**
 * The theme an HTML render styles against. Its background is the feed's own canvas.
 * Material You has no shared palette: it starts from the default one and takes the
 * roles its system colors replace. WebViews cannot load the app's bundled fonts, so
 * renders use system stacks.
 */
export function mobileHtmlRenderTheme(input: {
  readonly themeId: MobileThemeId;
  readonly appearance: MobileThemeAppearance;
  readonly variables: MobileThemeVariables;
  readonly systemColors: boolean;
  readonly platform: string;
}) {
  const { variables: v } = input;
  const palette = getMobileThemeColors(
    input.themeId === "material-you" ? DEFAULT_MOBILE_THEME_ID : input.themeId,
    input.appearance,
  );
  const colors = nativeColors(
    input.systemColors
      ? {
          ...palette,
          text: v["--color-foreground"],
          textMuted: v["--color-foreground-secondary"],
          muted: v["--color-subtle"],
          mutedForeground: v["--color-foreground-muted"],
          surface: v["--color-card"],
          surfaceRaised: v["--color-card-alt"],
          surfaceOverlay: v["--color-card-alt"],
          border: v["--color-border"],
          input: v["--color-input-border"],
          focus: v["--color-focus"],
          accent: v["--color-primary"],
          accentForeground: v["--color-primary-foreground"],
          accentSurface: v["--color-inline-skill-background"],
          accentSurfaceForeground: v["--color-inline-skill-foreground"],
          messageAction: v["--color-primary"],
          messageActionForeground: v["--color-primary-foreground"],
          secondary: v["--color-secondary"],
          secondaryForeground: v["--color-secondary-foreground"],
          errorSurface: v["--color-danger"],
          errorForeground: v["--color-danger-foreground"],
          codeBackground: v["--color-md-code-bg"],
          codeForeground: v["--color-md-code-text"],
        }
      : palette,
  );
  // Android paints the thread on its own canvas role; iOS uses the screen.
  const canvas = v[input.platform === "android" ? "--color-thread-canvas" : "--color-screen"];
  return htmlRenderTheme({ ...colors, canvas }, input.appearance, HTML_RENDER_DEFAULT_FONTS);
}

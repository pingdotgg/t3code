export interface BuildFontFamilies {
  readonly regular: string;
  readonly medium: string;
  readonly semibold: string;
  readonly bold: string;
  /** Hero headlines and the wordmark. */
  readonly display: string;
  /** Sheet and screen-sized titles. */
  readonly displayBold: string;
  /** Native header titles; null keeps the platform's own font. */
  readonly header: string | null;
  readonly headerHeavy: string | null;
  /** Code, diffs and command output; null keeps each surface's platform monospace. */
  readonly mono: string | null;
  readonly monoMedium: string | null;
}

// Stock values reproduce what each token's call sites rendered before the fork's fonts existed.
const STOCK_FONT_FAMILIES: BuildFontFamilies = {
  regular: "DMSans-Regular",
  medium: "DMSans-Medium",
  semibold: "DMSans-Regular",
  bold: "DMSans-Bold",
  display: "DMSans-Medium",
  displayBold: "DMSans-Bold",
  header: null,
  headerHeavy: null,
  mono: null,
  monoMedium: null,
};

// app.config.ts compiles these into standalone builds only; app.config.test.ts checks each.
const EASYDEV_FONT_FAMILIES = {
  regular: "Inter-Regular",
  medium: "Inter-Medium",
  semibold: "Inter-SemiBold",
  bold: "Inter-Bold",
  display: "Outfit-SemiBold",
  displayBold: "Outfit-Bold",
  header: "Outfit-SemiBold",
  headerHeavy: "Outfit-ExtraBold",
  mono: "JetBrainsMono-Regular",
  monoMedium: "JetBrainsMono-Medium",
} as const satisfies BuildFontFamilies;

export function resolveBuildFontFamilies(standalone: boolean): BuildFontFamilies {
  return standalone ? EASYDEV_FONT_FAMILIES : STOCK_FONT_FAMILIES;
}

/** Uniwind variables behind the font utilities in global.css; stock builds keep the CSS values. */
export function buildFontCssVariables(standalone: boolean): Readonly<Record<string, string>> {
  if (!standalone) return {};
  const families = EASYDEV_FONT_FAMILIES;
  return {
    "--font-sans": families.regular,
    "--font-medium": families.medium,
    "--font-t3-semibold": families.semibold,
    "--font-bold": families.bold,
    "--font-display": families.display,
    "--font-display-bold": families.displayBold,
    "--font-mono": families.mono,
  };
}

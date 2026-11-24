export const FONT_FAMILIES = {
  regular: "DMSans-Regular",
  medium: "DMSans-Medium",
  bold: "DMSans-Bold",
} as const;

export interface ResolvedFontFamilies {
  readonly regular: string;
  readonly medium: string;
  readonly bold: string;
}

export function resolveFontFamilies(
  useMonospaceFont: boolean,
  platformOS?: string,
): ResolvedFontFamilies {
  if (!useMonospaceFont) return FONT_FAMILIES;
  if (platformOS === "ios") {
    return { regular: "Menlo", medium: "Menlo", bold: "Menlo-Bold" };
  }
  return { regular: "monospace", medium: "monospace", bold: "monospace" };
}

export function resolveUniwindFontFamilyVariables(
  useMonospaceFont: boolean,
  platformOS?: string,
): Readonly<Record<string, string>> {
  if (!useMonospaceFont) {
    return {
      "--font-sans": FONT_FAMILIES.regular,
      "--font-medium": FONT_FAMILIES.medium,
      "--font-bold": FONT_FAMILIES.bold,
    };
  }
  const mono = platformOS === "ios" ? "ui-monospace" : "monospace";
  return {
    "--font-sans": mono,
    "--font-medium": mono,
    "--font-bold": mono,
  };
}

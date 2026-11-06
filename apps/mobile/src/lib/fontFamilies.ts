import { BUILT_IN_THEMES } from "@t3tools/shared/themePalettes";

export const FONT_FAMILIES = {
  regular: "DMSans-Regular",
  medium: "DMSans-Medium",
  bold: "DMSans-Bold",
  code: undefined,
} as const;

const ABSOLUTELY_FONT_FAMILIES = {
  regular: "DMSans-Regular",
  medium: "DMSans-Medium",
  bold: "DMSans-Bold",
  code: "JetBrainsMono-Regular",
} as const;

export function getMobileFontFamilies(themeId: string) {
  return BUILT_IN_THEMES.find((theme) => theme.id === themeId)?.typography === "absolutely"
    ? ABSOLUTELY_FONT_FAMILIES
    : FONT_FAMILIES;
}

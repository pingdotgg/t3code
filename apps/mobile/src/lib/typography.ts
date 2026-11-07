import { BUILT_IN_THEMES } from "@t3tools/shared/themePalettes";

export function getMobileReplyTypography(themeId: string, baseFontSize = 16) {
  if (BUILT_IN_THEMES.find((theme) => theme.id === themeId)?.typography !== "absolutely")
    return null;
  const scale = baseFontSize / 16;
  return {
    fontSize: 15 * scale,
    lineHeight: 22 * scale,
    codeBlockFontSize: 14 * scale,
    codeBlockLineHeight: 22.75 * scale,
    headingLineHeightMultiplier: 1.25,
    headingFontSizes: [26.25, 20.625, 16.875, 15, 13.125, 13.125].map((size) => size * scale),
    fontFamily: "SourceSerif4-Regular",
    headingFontFamily: "SourceSerif4-Semibold",
    boldFontFamily: "SourceSerif4-Semibold",
  };
}

export function getMobileUserTypography(themeId: string, baseFontSize = 16) {
  const reply = getMobileReplyTypography(themeId, baseFontSize);
  return reply
    ? {
        fontSize: reply.fontSize,
        lineHeight: (20 * baseFontSize) / 16,
        codeBlockFontSize: reply.codeBlockFontSize,
        codeBlockLineHeight: reply.codeBlockLineHeight,
      }
    : null;
}

export const MOBILE_TYPOGRAPHY = {
  micro: { fontSize: 11, lineHeight: 14 },
  caption: { fontSize: 12, lineHeight: 16 },
  label: { fontSize: 13, lineHeight: 17 },
  footnote: { fontSize: 14, lineHeight: 19 },
  body: { fontSize: 16, lineHeight: 23 },
  headline: { fontSize: 18, lineHeight: 23 },
  title: { fontSize: 21, lineHeight: 28 },
  largeTitle: { fontSize: 26, lineHeight: 32 },
  display: { fontSize: 30, lineHeight: 36 },
} as const;

export const MOBILE_CODE_SURFACE = {
  rowHeight: 22,
  gutterWidth: 46,
  codePadding: 7,
  textVerticalInset: 2,
  fontSize: MOBILE_TYPOGRAPHY.caption.fontSize,
  lineNumberFontSize: MOBILE_TYPOGRAPHY.micro.fontSize,
} as const;

/** Class names share the same scaled CSS variables as native text roles. */
export const MOBILE_TEXT_CLASSES = {
  micro: "text-3xs",
  caption: "text-2xs",
  label: "text-xs",
  footnote: "text-sm",
  body: "text-base",
  headline: "text-lg",
  title: "text-xl",
  largeTitle: "text-2xl",
  display: "text-3xl",
} as const satisfies Record<keyof typeof MOBILE_TYPOGRAPHY, string>;

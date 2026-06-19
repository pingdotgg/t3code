export const MOBILE_TYPOGRAPHY = {
  micro: { fontSize: 10, lineHeight: 13 },
  caption: { fontSize: 11, lineHeight: 15 },
  label: { fontSize: 12, lineHeight: 16 },
  footnote: { fontSize: 13, lineHeight: 18 },
  composer: { fontSize: 14, lineHeight: 20 },
  body: { fontSize: 15, lineHeight: 22 },
  headline: { fontSize: 17, lineHeight: 22 },
  title: { fontSize: 20, lineHeight: 26 },
  largeTitle: { fontSize: 24, lineHeight: 30 },
  display: { fontSize: 28, lineHeight: 34 },
} as const;

/** Shared geometry for dense, horizontally scrolling code surfaces. */
export const MOBILE_CODE_SURFACE = {
  rowHeight: 20,
  gutterWidth: 46,
  codePadding: 7,
  textVerticalInset: 2,
  fontSize: MOBILE_TYPOGRAPHY.caption.fontSize,
  lineNumberFontSize: MOBILE_TYPOGRAPHY.micro.fontSize,
} as const;

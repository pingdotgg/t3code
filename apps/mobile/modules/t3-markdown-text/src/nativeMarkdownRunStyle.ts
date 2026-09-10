import type { TextStyle } from "react-native";
import type { NativeMarkdownTextRun } from "./nativeMarkdownText";
import type { NativeMarkdownTextStyle } from "./SelectableMarkdownText.types";

const PARAGRAPH_STYLE_ENCODING_OFFSET = 1000;
const DEFAULT_BODY_FONT_SIZE = 15;
const DEFAULT_HEADING_FONT_SIZES = [22, 19, 17, 16, 15, 15] as const;

function resolveHeadingFontSize(textStyle: NativeMarkdownTextStyle, headingLevel: number): number {
  const index = Math.max(0, Math.min(5, headingLevel - 1));
  const configured = textStyle.headingFontSizes?.[index];
  if (typeof configured === "number" && Number.isFinite(configured)) {
    return configured;
  }

  const scale = textStyle.fontSize / DEFAULT_BODY_FONT_SIZE;
  return Math.max(12, Math.round(DEFAULT_HEADING_FONT_SIZES[index] * scale));
}

export function nativeMarkdownRunStyle(
  run: NativeMarkdownTextRun,
  textStyle: NativeMarkdownTextStyle,
  monoFontFamily: string,
) {
  const isFile = run.fileIcon != null;
  const isSkill = run.skillName != null;
  const headingLevel = Math.max(1, Math.min(6, run.headingLevel ?? 1));
  const headingFontSize = resolveHeadingFontSize(textStyle, headingLevel);
  const isHeading = run.role === "heading";
  const isCodeBlock = run.role === "code-block" || run.role === "code-language";
  const hasParagraphStyle = run.headIndent !== undefined;
  const textDecorationLine = run.strikethrough
    ? "line-through"
    : run.href && !isFile
      ? "underline"
      : "none";

  return {
    color: isFile
      ? textStyle.fileTextColor
      : isSkill
        ? textStyle.skillTextColor
        : run.href
          ? textStyle.linkColor
          : isHeading
            ? textStyle.strongColor
            : run.role === "quote-marker"
              ? textStyle.quoteMarkerColor
              : run.role === "divider"
                ? textStyle.dividerColor
                : run.role === "code-language"
                  ? textStyle.mutedColor
                  : run.role === "list-marker"
                    ? textStyle.mutedColor
                    : isCodeBlock
                      ? textStyle.codeColor
                      : run.code
                        ? textStyle.inlineCodeColor
                        : run.bold
                          ? textStyle.strongColor
                          : textStyle.color,
    fontFamily:
      isFile || isSkill
        ? textStyle.boldFontFamily
        : run.code || isCodeBlock
          ? monoFontFamily
          : isHeading
            ? textStyle.headingFontFamily
            : run.bold
              ? textStyle.boldFontFamily
              : textStyle.fontFamily,
    fontSize:
      run.role === "spacer"
        ? (run.spacing ?? 10)
        : run.role === "list-break"
          ? textStyle.fontSize
          : isHeading
            ? headingFontSize
            : run.role === "code-language"
              ? Math.max(10, Math.round(textStyle.fontSize * 0.73))
              : run.code || isCodeBlock
                ? Math.max(12, textStyle.fontSize - 2)
                : textStyle.fontSize,
    lineHeight:
      run.role === "spacer"
        ? (run.spacing ?? 10)
        : run.role === "list-break"
          ? textStyle.lineHeight + (run.spacing ?? 0)
          : isHeading
            ? Math.max(headingFontSize + 6, textStyle.lineHeight + 2)
            : isCodeBlock
              ? Math.max(16, textStyle.lineHeight - 2)
              : textStyle.lineHeight,
    fontStyle: run.italic ? "italic" : "normal",
    fontWeight: isHeading || run.bold || isFile || isSkill ? "700" : "400",
    textDecorationLine,
    backgroundColor: isCodeBlock ? textStyle.codeBlockBackgroundColor : undefined,
    ...(hasParagraphStyle
      ? {
          shadowColor: "transparent",
          shadowOffset: {
            width: run.firstLineHeadIndent ?? 0,
            height: run.headIndent,
          },
          shadowRadius: PARAGRAPH_STYLE_ENCODING_OFFSET + (run.paragraphSpacing ?? 0),
        }
      : {}),
  } satisfies TextStyle;
}

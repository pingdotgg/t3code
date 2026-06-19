import { Image, Linking, type TextStyle, useColorScheme } from "react-native";

import { MarkdownTextPrimitive } from "./MarkdownTextPrimitive";
import { markdownFileIconSource } from "./markdownFileIcons";
import type { NativeMarkdownTextRun } from "./nativeMarkdownText";
import type { NativeMarkdownTextStyle } from "./SelectableMarkdownText.types";

const EXTERNAL_LINK_PREFIX = "◉ ";
const INLINE_ATTACHMENT_PREFIX = "\uFFFC\u00A0";
const SKILL_ICON_PLACEHOLDER = "\uFFFC";
const PARAGRAPH_STYLE_ENCODING_OFFSET = 1000;

function runKeySignature(run: NativeMarkdownTextRun): string {
  return [
    run.text,
    run.bold,
    run.italic,
    run.strikethrough,
    run.code,
    run.href,
    run.externalHost,
    run.fileIcon,
    run.skillName,
    run.skillLabel,
    run.role,
    run.headingLevel,
    run.depth,
    run.spacing,
    run.firstLineHeadIndent,
    run.headIndent,
    run.paragraphSpacing,
  ].join(":");
}

function runStyle(run: NativeMarkdownTextRun, textStyle: NativeMarkdownTextStyle): TextStyle {
  const isFile = run.fileIcon != null;
  const isSkill = run.skillName != null;
  const headingLevel = Math.max(1, Math.min(6, run.headingLevel ?? 1));
  const headingFontSize = [22, 19, 17, 16, 15, 15][headingLevel - 1] ?? 15;
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
          ? "ui-monospace"
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
              ? 11
              : run.code || isCodeBlock
                ? Math.max(12, textStyle.fontSize - 2)
                : textStyle.fontSize,
    lineHeight:
      run.role === "spacer"
        ? (run.spacing ?? 10)
        : run.role === "list-break"
          ? textStyle.lineHeight + (run.spacing ?? 0)
          : isHeading
            ? Math.max(headingFontSize + 6, 20)
            : isCodeBlock
              ? 18
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
  };
}

export function NativeMarkdownSelectableText(props: {
  readonly runs: ReadonlyArray<NativeMarkdownTextRun>;
  readonly textStyle: NativeMarkdownTextStyle;
  readonly onLinkPress?: (href: string) => void;
}) {
  const colorScheme = useColorScheme();
  const occurrences = new Map<string, number>();
  const prefixedExternalLinks = new Set<string>();
  const keyedRuns = props.runs.map((run) => {
    const signature = runKeySignature(run);
    const occurrence = occurrences.get(signature) ?? 0;
    occurrences.set(signature, occurrence + 1);

    let text = run.text;
    if (run.fileIcon) {
      text = `${INLINE_ATTACHMENT_PREFIX}${text}`;
    } else if (run.skillName && run.skillLabel) {
      text = `${SKILL_ICON_PLACEHOLDER}\u00A0${run.skillLabel}`;
    } else if (run.externalHost && run.href && !prefixedExternalLinks.has(run.href)) {
      prefixedExternalLinks.add(run.href);
      text = `${EXTERNAL_LINK_PREFIX}${text}`;
    }

    return { key: `${signature}:${occurrence}`, run, text };
  });
  // T3MarkdownText only rebuilds its attributed string during native layout. A
  // color-only child update can otherwise leave the previous appearance cached.
  const appearanceKey = [
    colorScheme ?? "unspecified",
    props.textStyle.color,
    props.textStyle.strongColor,
    props.textStyle.mutedColor,
    props.textStyle.linkColor,
    props.textStyle.inlineCodeColor,
    props.textStyle.codeColor,
    props.textStyle.codeBackgroundColor,
    props.textStyle.codeBlockBackgroundColor,
    props.textStyle.fileTextColor,
    props.textStyle.skillTextColor,
    props.textStyle.quoteMarkerColor,
    props.textStyle.dividerColor,
  ].join(":");

  return (
    <MarkdownTextPrimitive
      key={appearanceKey}
      uiTextView
      selectable
      style={{
        flexShrink: 1,
        minWidth: 0,
        color: props.textStyle.color,
        fontFamily: props.textStyle.fontFamily,
        fontSize: props.textStyle.fontSize,
        lineHeight: props.textStyle.lineHeight,
      }}
    >
      {keyedRuns.map(({ key, run, text }) => {
        const href = run.href;
        return (
          <MarkdownTextPrimitive
            key={key}
            nativeID={
              run.fileIcon
                ? `t3-file:${Image.resolveAssetSource(markdownFileIconSource(run.fileIcon)).uri}`
                : run.skillName
                  ? "t3-skill:sf:cube"
                  : undefined
            }
            style={runStyle(run, props.textStyle)}
            onPress={
              href
                ? () => {
                    if (props.onLinkPress) {
                      props.onLinkPress(href);
                    } else {
                      void Linking.openURL(href);
                    }
                  }
                : undefined
            }
          >
            {text}
          </MarkdownTextPrimitive>
        );
      })}
    </MarkdownTextPrimitive>
  );
}

import { createContext, useCallback, useContext } from "react";
import {
  findNodeHandle,
  Image,
  Linking,
  Platform,
  StyleSheet,
  Text as RNText,
  type TextStyle,
  useColorScheme,
} from "react-native";

import { MarkdownTextPrimitive } from "./MarkdownTextPrimitive";
import { markdownFileIconSource } from "./markdownFileIcons";
import type { NativeMarkdownTextRun } from "./nativeMarkdownText";
import type {
  MarkdownFileContextMenu,
  NativeMarkdownTextStyle,
} from "./SelectableMarkdownText.types";
import { installMarkdownCopySanitizer } from "./T3MarkdownTextSelectionModule";

export interface MarkdownFileContextMenuHandlers {
  readonly fileContextMenu: (href: string) => MarkdownFileContextMenu | undefined;
  readonly onFileContextMenuAction: (href: string, actionId: string) => void;
}

/** Set by SelectableMarkdownText so file chips anywhere in the block tree get the same menu. */
export const MarkdownFileContextMenuContext = createContext<MarkdownFileContextMenuHandlers | null>(
  null,
);

const EXTERNAL_LINK_PREFIX = "◉ ";
const INLINE_ATTACHMENT_PREFIX = "\uFFFC\u00A0";
const SKILL_ICON_PLACEHOLDER = "\uFFFC";
const PARAGRAPH_STYLE_ENCODING_OFFSET = 1000;
const MONO_FONT_FAMILY = Platform.select({
  ios: "ui-monospace",
  android: "monospace",
  default: "monospace",
});
const styles = StyleSheet.create({
  inlineIcon: {
    width: 14,
    height: 14,
    marginHorizontal: 3,
    transform: [{ translateY: 2 }],
  },
});

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

function runStyle(run: NativeMarkdownTextRun, textStyle: NativeMarkdownTextStyle): TextStyle {
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
          ? MONO_FONT_FAMILY
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
  };
}

export function NativeMarkdownSelectableText(props: {
  readonly runs: ReadonlyArray<NativeMarkdownTextRun>;
  readonly textStyle: NativeMarkdownTextStyle;
  readonly onLinkPress?: (href: string) => void;
}) {
  const colorScheme = useColorScheme();
  const menu = useContext(MarkdownFileContextMenuContext);
  const containsInlineFileIcon = props.runs.some((run) => run.fileIcon != null);
  const attachAndroidText = useCallback(
    (textView: RNText | null) => {
      if (Platform.OS !== "android" || !containsInlineFileIcon || textView === null) {
        return;
      }
      const reactTag = findNodeHandle(textView);
      if (reactTag !== null) {
        installMarkdownCopySanitizer(reactTag);
      }
    },
    [containsInlineFileIcon],
  );
  const occurrences = new Map<string, number>();
  const prefixedExternalLinks = new Set<string>();
  const keyedRuns = props.runs.map((run) => {
    const signature = runKeySignature(run);
    const occurrence = occurrences.get(signature) ?? 0;
    occurrences.set(signature, occurrence + 1);

    let text = run.text;
    if (run.fileIcon && Platform.OS === "ios") {
      text = `${INLINE_ATTACHMENT_PREFIX}${text}`;
    } else if (run.skillName && run.skillLabel) {
      text =
        Platform.OS === "ios"
          ? `${SKILL_ICON_PLACEHOLDER}\u00A0${run.skillLabel}`
          : `$${run.skillName}`;
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
    props.textStyle.fontSize,
    props.textStyle.lineHeight,
    props.textStyle.headingFontSizes?.join(","),
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
      nativeTextRef={attachAndroidText}
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
        const contextMenu = run.fileIcon && href ? menu?.fileContextMenu(href) : undefined;
        return (
          <MarkdownTextPrimitive
            key={key}
            nativeID={
              Platform.OS === "ios"
                ? run.fileIcon
                  ? `t3-file:${Image.resolveAssetSource(markdownFileIconSource(run.fileIcon)).uri}`
                  : run.skillName
                    ? "t3-skill:sf:cube"
                    : undefined
                : undefined
            }
            contextMenuConfig={contextMenu ? JSON.stringify(contextMenu) : undefined}
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
            onContextMenuAction={
              contextMenu && href && menu
                ? (event) => menu.onFileContextMenuAction(href, event.nativeEvent.actionIdentifier)
                : undefined
            }
          >
            {Platform.OS === "android" && run.fileIcon ? (
              <Image source={markdownFileIconSource(run.fileIcon)} style={styles.inlineIcon} />
            ) : null}
            {text}
          </MarkdownTextPrimitive>
        );
      })}
    </MarkdownTextPrimitive>
  );
}

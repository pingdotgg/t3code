import { createContext, useCallback, useContext, useMemo } from "react";
import { decodeComposerContextFragment } from "@t3tools/shared/composerContextClipboard";
import {
  findNodeHandle,
  Image,
  Linking,
  Platform,
  StyleSheet,
  Text as RNText,
  type TextStyle,
  useColorScheme,
  View,
} from "react-native";

import { MarkdownTextPrimitive } from "./MarkdownTextPrimitive";
import { markdownFileIconSource } from "./markdownFileIcons";
import { markdownLinkIconSource } from "./markdownLinkIcons";
import { resolveMarkdownFileIcon, resolveMarkdownLinkIcon } from "./markdownLinks";
import type { NativeMarkdownTextRun } from "./nativeMarkdownText";
import { nativeMarkdownContextCopyRanges } from "./nativeMarkdownText";
import type {
  MarkdownFileContextMenu,
  NativeMarkdownTextStyle,
} from "./SelectableMarkdownText.types";
import {
  installMarkdownCopySanitizer,
  renderAndroidContextChip,
} from "./T3MarkdownTextSelectionModule";
import { parseComposerContextHref } from "@t3tools/shared/composerContextReferences";
import { contextChipPresentation } from "./nativeMarkdownText";

export const MarkdownContextClipboardContext = createContext("");

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
// React Native turns a run whose whole text is U+FFFC into a bare inline-view attachment
// with no font or paragraph style, so a chip opening a paragraph would drop its line
// height. Any other single character keeps the run's attributes; the native side swaps it
// for the chip attachment either way.
const IOS_CHIP_PLACEHOLDER = "\u200B";
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
    run.sourceText,
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
  return Math.max(12, Math.round((DEFAULT_HEADING_FONT_SIZES[index] ?? 15) * scale));
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
    backgroundColor: isCodeBlock
      ? textStyle.codeBlockBackgroundColor
      : parseComposerContextHref(run.href ?? "")
        ? textStyle.codeBackgroundColor
        : undefined,
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
  const contextClipboardFragment = useContext(MarkdownContextClipboardContext);
  const contextRecords = useMemo(
    () => decodeComposerContextFragment(contextClipboardFragment)?.records ?? [],
    [contextClipboardFragment],
  );
  const containsInlineIcon = props.runs.some(
    (run) =>
      run.fileIcon != null ||
      run.skillName != null ||
      parseComposerContextHref(run.href ?? "") !== null ||
      (run.externalHost != null && resolveMarkdownLinkIcon(run.externalHost) !== null),
  );
  const keyedRuns = useMemo(() => {
    const occurrences = new Map<string, number>();
    const prefixedExternalLinks = new Set<string>();
    return props.runs.map((run) => {
      const signature = runKeySignature(run);
      const occurrence = occurrences.get(signature) ?? 0;
      occurrences.set(signature, occurrence + 1);

      let text = run.text;
      let linkIcon = null;
      const contextReference = parseComposerContextHref(run.href ?? "");
      const contextRecord = contextReference
        ? contextRecords.find((record) => record.contextId === contextReference.contextId)
        : undefined;
      const chip =
        contextReference || run.skillName || run.fileIcon
          ? {
              ...contextChipPresentation(
                contextReference?.kind ?? (run.skillName ? "skill" : "mention"),
                contextRecord,
              ),
              label: run.skillLabel ?? run.text,
              interactive: Boolean(run.href),
              iconUri:
                !contextReference && run.fileIcon
                  ? Image.resolveAssetSource(markdownFileIconSource(run.fileIcon)).uri
                  : contextRecord?.kind === "mention" && "path" in contextRecord
                    ? Image.resolveAssetSource(
                        markdownFileIconSource(resolveMarkdownFileIcon(contextRecord.path)),
                      ).uri
                    : undefined,
              fontSize: props.textStyle.fontSize * 0.8,
              foreground: props.textStyle.color,
              border: props.textStyle.contextChipBorderColor ?? props.textStyle.dividerColor,
            }
          : null;
      // Android sizes the chip's inline box from the paragraph font so the line box stays
      // the height of a plain text line; see renderContextChip.
      const androidChip =
        Platform.OS === "android" && chip
          ? renderAndroidContextChip(
              JSON.stringify({
                ...chip,
                text: {
                  fontFamily: props.textStyle.fontFamily,
                  fontSize: props.textStyle.fontSize,
                },
              }),
            )
          : null;
      if (androidChip) {
        text = "";
      } else if (chip && Platform.OS === "ios") {
        text = IOS_CHIP_PLACEHOLDER;
      } else if (run.fileIcon && Platform.OS === "ios") {
        text = `${INLINE_ATTACHMENT_PREFIX}${text}`;
      } else if (run.skillName && run.skillLabel) {
        text =
          Platform.OS === "ios"
            ? `${SKILL_ICON_PLACEHOLDER}\u00A0${run.skillLabel}`
            : `$${run.skillName}`;
      } else if (run.externalHost && run.href && !prefixedExternalLinks.has(run.href)) {
        prefixedExternalLinks.add(run.href);
        linkIcon = resolveMarkdownLinkIcon(run.externalHost);
        if (linkIcon === null) {
          text = `${EXTERNAL_LINK_PREFIX}${text}`;
        } else if (Platform.OS === "ios") {
          text = `${INLINE_ATTACHMENT_PREFIX}${text}`;
        }
      }

      return { key: `${signature}:${occurrence}`, run, text, linkIcon, chip, androidChip };
    });
  }, [props.runs, props.textStyle, contextRecords]);
  const ranges = nativeMarkdownContextCopyRanges(
    keyedRuns.map(({ run, text, linkIcon, androidChip }) => ({
      run,
      text,
      inlineImageLength:
        Platform.OS === "android" && (androidChip || run.fileIcon || linkIcon) ? 1 : 0,
    })),
  );
  const contextClipboardConfig = ranges.length
    ? JSON.stringify({ fragment: contextClipboardFragment, ranges })
    : "";
  const attachAndroidText = useCallback(
    (textView: RNText | null) => {
      if (Platform.OS !== "android" || !containsInlineIcon || !textView) return;
      const reactTag = findNodeHandle(textView);
      if (reactTag !== null) installMarkdownCopySanitizer(reactTag, contextClipboardConfig);
    },
    [containsInlineIcon, contextClipboardConfig],
  );
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
    props.textStyle.contextChipBorderColor,
  ].join(":");

  return (
    <MarkdownTextPrimitive
      key={appearanceKey}
      nativeTextRef={attachAndroidText}
      contextClipboardConfig={contextClipboardConfig}
      accessibilityLabel={
        Platform.OS === "android" && containsInlineIcon
          ? props.runs.map((run) => run.skillLabel ?? run.text).join("")
          : undefined
      }
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
      {keyedRuns.map(({ key, run, text, linkIcon, chip, androidChip }) => {
        const href = run.href;
        const contextMenu = run.fileIcon && href ? menu?.fileContextMenu(href) : undefined;
        const onPress = href
          ? () => {
              if (props.onLinkPress) props.onLinkPress(href);
              else void Linking.openURL(href);
            }
          : undefined;
        return (
          <MarkdownTextPrimitive
            key={key}
            accessibilityLabel={androidChip ? chip?.label : undefined}
            nativeID={
              Platform.OS === "ios"
                ? chip
                  ? `t3-chip:${JSON.stringify(chip)}`
                  : run.fileIcon
                    ? `t3-file:${Image.resolveAssetSource(markdownFileIconSource(run.fileIcon)).uri}`
                    : run.skillName
                      ? "t3-skill:sf:cube"
                      : linkIcon
                        ? `t3-link:${Image.resolveAssetSource(markdownLinkIconSource(linkIcon)).uri}`
                        : undefined
                : undefined
            }
            contextMenuConfig={contextMenu ? JSON.stringify(contextMenu) : undefined}
            style={[
              runStyle(run, props.textStyle),
              chip ? { backgroundColor: "transparent" } : undefined,
            ]}
            onPress={onPress}
            onContextMenuAction={
              contextMenu && href && menu
                ? (event) => menu.onFileContextMenuAction(href, event.nativeEvent.actionIdentifier)
                : undefined
            }
          >
            {androidChip ? (
              // The inline box sits on the baseline and is only as tall as the font's
              // ascent, so it never changes the line's height. The bitmap hangs off that
              // box (views in text are not clipped) to centre the chip on the text.
              <View
                accessible
                accessibilityLabel={chip?.label}
                accessibilityRole={onPress ? "button" : "image"}
                accessibilityActions={onPress ? [{ name: "activate" }] : undefined}
                onAccessibilityAction={
                  onPress
                    ? (event) => {
                        if (event.nativeEvent.actionName === "activate") onPress();
                      }
                    : undefined
                }
                style={{ width: androidChip.width, height: androidChip.boxHeight }}
              >
                <Image
                  // The bitmap is measured in whole pixels but laid out in dp, so the box can
                  // round a hair narrower than the image. `cover` would crop that difference
                  // off the right-hand border; `contain` fits the whole chip instead.
                  resizeMode="contain"
                  source={{ uri: androidChip.uri }}
                  style={{
                    position: "absolute",
                    left: 0,
                    top: androidChip.offsetY,
                    width: androidChip.width,
                    height: androidChip.height,
                  }}
                />
              </View>
            ) : Platform.OS === "android" && run.fileIcon ? (
              <Image source={markdownFileIconSource(run.fileIcon)} style={styles.inlineIcon} />
            ) : Platform.OS === "android" && linkIcon ? (
              <Image
                source={markdownLinkIconSource(linkIcon)}
                style={styles.inlineIcon}
                tintColor={props.textStyle.linkColor}
              />
            ) : null}
            {text}
          </MarkdownTextPrimitive>
        );
      })}
    </MarkdownTextPrimitive>
  );
}

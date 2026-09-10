import { nativeMarkdownRunStyle } from "./nativeMarkdownRunStyle";
import { NativeMathText } from "./NativeMathText";
import { createContext, useCallback, useContext } from "react";
import {
  findNodeHandle,
  Image,
  Linking,
  Platform,
  StyleSheet,
  Text as RNText,
  useColorScheme,
} from "react-native";

import { MarkdownTextPrimitive } from "./MarkdownTextPrimitive";
import { markdownFileIconSource } from "./markdownFileIcons";
import { markdownLinkIconSource } from "./markdownLinkIcons";
import { resolveMarkdownLinkIcon } from "./markdownLinks";
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

export function NativeMarkdownSelectableText(props: {
  readonly runs: ReadonlyArray<NativeMarkdownTextRun>;
  readonly textStyle: NativeMarkdownTextStyle;
  readonly onLinkPress?: (href: string) => void;
}) {
  const colorScheme = useColorScheme();
  const menu = useContext(MarkdownFileContextMenuContext);
  const containsInlineIcon = props.runs.some(
    (run) =>
      run.fileIcon != null ||
      (run.externalHost != null && resolveMarkdownLinkIcon(run.externalHost) !== null),
  );
  const attachAndroidText = useCallback(
    (textView: RNText | null) => {
      if (Platform.OS !== "android" || !containsInlineIcon || textView === null) {
        return;
      }
      const reactTag = findNodeHandle(textView);
      if (reactTag !== null) {
        installMarkdownCopySanitizer(reactTag);
      }
    },
    [containsInlineIcon],
  );
  const occurrences = new Map<string, number>();
  const prefixedExternalLinks = new Set<string>();
  const keyedRuns = props.runs.map((run) => {
    const signature = runKeySignature(run);
    const occurrence = occurrences.get(signature) ?? 0;
    occurrences.set(signature, occurrence + 1);

    let text = run.text;
    let linkIcon = null;
    if (run.fileIcon && Platform.OS === "ios") {
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

    return { key: `${signature}:${occurrence}`, run, text, linkIcon };
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

  const nativeText = (
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
      {keyedRuns.map(({ key, run, text, linkIcon }) => {
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
                    : linkIcon
                      ? `t3-link:${Image.resolveAssetSource(markdownLinkIconSource(linkIcon)).uri}`
                      : undefined
                : undefined
            }
            contextMenuConfig={contextMenu ? JSON.stringify(contextMenu) : undefined}
            style={nativeMarkdownRunStyle(run, props.textStyle, MONO_FONT_FAMILY ?? "monospace")}
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
  return props.runs.some((run) => run.mathSource !== undefined) ? (
    <NativeMathText {...props} {...(menu ?? {})} fallback={nativeText} />
  ) : (
    nativeText
  );
}

import { useCallback, useMemo, useState } from "react";
import { ActionSheetIOS, Platform, View } from "react-native";
import {
  EnrichedMarkdownText,
  type DocumentAssetsEvent,
  type MarkdownStyle,
  type MarkdownMediaAsset,
} from "react-native-enriched-markdown";
import type { SelectableMarkdownTextProps } from "./SelectableMarkdownText.types";

import { useAppearancePreferences } from "../features/settings/appearance/AppearancePreferencesProvider";
import { AndroidAnchoredMenu } from "../components/AndroidAnchoredMenu";
import { useEnrichedLinkVariants } from "./useEnrichedLinkVariants";
import { copyTextWithHaptic } from "../lib/copyTextWithHaptic";
import {
  ENRICHED_INLINE_FILE_LINK_REGEX,
  enrichedSkillLinkRegex,
} from "../lib/enrichedLinkPresentation";

function enrichedStyle(
  style: SelectableMarkdownTextProps["textStyle"],
  dark: boolean,
): MarkdownStyle {
  const monospace = Platform.OS === "ios" ? "Menlo" : "monospace";
  const body = {
    color: style.color,
    fontFamily: style.fontFamily,
    fontSize: style.fontSize,
    lineHeight: style.lineHeight,
    marginTop: 0,
    marginBottom: 8,
  };
  const heading = (level: number) => {
    const fontSize = style.headingFontSizes?.[level - 1] ?? style.fontSize * (1.6 - level * 0.1);
    return {
      ...body,
      color: style.strongColor,
      fontFamily: style.headingFontFamily,
      fontSize,
      lineHeight: fontSize * 1.35,
      marginTop: 8,
    };
  };
  return {
    paragraph: body,
    h1: heading(1),
    h2: heading(2),
    h3: heading(3),
    h4: heading(4),
    h5: heading(5),
    h6: heading(6),
    strong: { color: style.strongColor, fontFamily: style.boldFontFamily, fontWeight: "normal" },
    link: { color: style.linkColor, underline: false },
    code: {
      fontFamily: monospace,
      color: style.inlineCodeColor,
      backgroundColor: style.codeBackgroundColor,
      borderColor: "transparent",
      fontSize: style.fontSize * 0.9,
    },
    codeBlock: {
      ...body,
      color: style.codeColor,
      backgroundColor: style.codeBlockBackgroundColor,
      fontFamily: monospace,
      fontSize: style.fontSize * 0.9,
      borderRadius: 8,
      padding: 12,
      borderWidth: 1,
      borderColor: style.dividerColor,
      syntaxColors: dark
        ? {
            keyword: "#ff7b72",
            string: "#a5d6ff",
            number: "#79c0ff",
            constant: "#79c0ff",
            comment: "#8b949e",
            function: "#d2a8ff",
            type: "#ffa657",
            property: "#79c0ff",
            tag: "#7ee787",
            attribute: "#79c0ff",
          }
        : {
            keyword: "#cf222e",
            string: "#0a3069",
            number: "#0550ae",
            constant: "#0550ae",
            comment: "#6e7781",
            function: "#8250df",
            type: "#953800",
            property: "#0550ae",
            tag: "#116329",
            attribute: "#0550ae",
          },
    },
    blockquote: {
      ...body,
      color: style.mutedColor,
      borderColor: style.quoteMarkerColor,
      borderWidth: 2,
      gapWidth: 12,
    },
    list: { ...body, bulletColor: style.mutedColor, markerColor: style.mutedColor, gapWidth: 6 },
    thematicBreak: { color: style.dividerColor, height: 1, marginTop: 8, marginBottom: 8 },
    table: {
      ...body,
      borderColor: style.dividerColor,
      borderWidth: 1,
      headerFontFamily: style.boldFontFamily,
      headerTextColor: style.strongColor,
      headerBackgroundColor: style.codeBackgroundColor,
      rowEvenBackgroundColor: "transparent",
      rowOddBackgroundColor: "transparent",
      cellPaddingHorizontal: 12,
      cellPaddingVertical: 8,
    },
    taskList: {
      checkedColor: style.linkColor,
      checkedTextColor: style.color,
      borderColor: style.mutedColor,
      checkedStrikethrough: false,
    },
  };
}

export function MobileEnrichedMarkdownText(props: SelectableMarkdownTextProps) {
  const { renderImage, resolveImageSource } = props;
  const { themeAppearance } = useAppearancePreferences();
  const [documentAssets, setDocumentAssets] = useState<DocumentAssetsEvent["assets"]>([]);
  const onDocumentAssets = useCallback(({ assets }: DocumentAssetsEvent) => {
    setDocumentAssets((previous) =>
      previous.length === assets.length &&
      previous.every((asset, index) => {
        const next = assets[index]!;
        return (
          asset.id === next.id &&
          asset.kind === next.kind &&
          asset.url === next.url &&
          asset.altText === next.altText &&
          asset.title === next.title &&
          asset.placement === next.placement &&
          asset.eligible === next.eligible
        );
      })
        ? previous
        : assets,
    );
  }, []);
  const linkVariants = useEnrichedLinkVariants(documentAssets, props);
  const skillLinkRegex = useMemo(() => enrichedSkillLinkRegex(props.skills), [props.skills]);
  const [activeMenu, setActiveMenu] = useState<{
    url: string;
    menu: NonNullable<ReturnType<NonNullable<typeof props.fileContextMenu>>>;
  } | null>(null);
  const { fileContextMenu, onLinkPress, onFileContextMenuAction } = props;
  const performMenuAction = useCallback(
    (url: string, actionId: string) => {
      if (actionId === "enriched-open-link") onLinkPress?.(url);
      else if (actionId === "enriched-copy-link") copyTextWithHaptic(url);
      else onFileContextMenuAction?.(url, actionId);
    },
    [onLinkPress, onFileContextMenuAction],
  );
  const linkContextMenus = useMemo(
    () =>
      Platform.OS === "ios" && fileContextMenu
        ? Object.fromEntries(
            [
              ...new Set(
                documentAssets.filter((asset) => asset.kind === "link").map((asset) => asset.url),
              ),
            ].map((url) => {
              const menu = fileContextMenu(url) ?? {
                title: url,
                actions: [
                  { id: "enriched-open-link", title: "Open link" },
                  { id: "enriched-copy-link", title: "Copy link" },
                ],
              };
              return [
                url,
                {
                  title: menu.title,
                  items: menu.actions.map((action) => ({
                    text: action.title,
                    disabled: "disabled" in action && action.disabled,
                    onPress: () => performMenuAction(url, action.id),
                  })),
                },
              ];
            }),
          )
        : undefined,
    [documentAssets, fileContextMenu, performMenuAction],
  );
  const markdownStyle = useMemo(
    () => ({ ...enrichedStyle(props.textStyle, themeAppearance === "dark"), linkVariants }),
    [props.textStyle, themeAppearance, linkVariants],
  );
  const renderMedia = useCallback(
    (asset: MarkdownMediaAsset) =>
      renderImage?.({
        href: asset.url,
        alt: asset.altText || null,
        title: asset.title || null,
      }) ?? null,
    [renderImage],
  );
  const resolveNativeImageSource = useCallback(
    (asset: MarkdownMediaAsset) =>
      resolveImageSource?.({
        href: asset.url,
        alt: asset.altText || null,
        title: asset.title || null,
      }) ?? null,
    [resolveImageSource],
  );
  const renderMarkdown = (openAndroidMenu?: () => void) => {
    const onLinkLongPress = props.fileContextMenu
      ? ({ url }: { url: string }) => {
          const menu = props.fileContextMenu?.(url) ?? {
            title: url,
            actions: [
              { id: "enriched-open-link", title: "Open link" },
              { id: "enriched-copy-link", title: "Copy link" },
            ],
          };
          const actions = menu.actions;
          if (Platform.OS === "ios") {
            ActionSheetIOS.showActionSheetWithOptions(
              {
                title: menu.title,
                options: [...actions.map((action) => action.title), "Cancel"],
                cancelButtonIndex: actions.length,
                disabledButtonIndices: actions.flatMap((action, index) =>
                  action.disabled ? [index] : [],
                ),
              },
              (index) => {
                const action = actions[index];
                if (action && !action.disabled) performMenuAction(url, action.id);
              },
            );
          } else {
            setActiveMenu({ url, menu });
            openAndroidMenu?.();
          }
        }
      : undefined;

    return (
      <View
        style={{
          flexShrink: 1,
          minWidth: 0,
          marginTop: props.marginTop,
          marginBottom: props.marginBottom,
        }}
      >
        <EnrichedMarkdownText
          markdown={props.markdown}
          markdownStyle={markdownStyle}
          onDocumentAssets={onDocumentAssets}
          renderMedia={renderImage ? renderMedia : undefined}
          resolveImageSource={resolveImageSource ? resolveNativeImageSource : undefined}
          onImagePress={
            props.onImagePress || props.onLinkPress
              ? ({ url }) => (props.onImagePress ?? props.onLinkPress)?.(url)
              : undefined
          }
          linkRegex={skillLinkRegex}
          inlineCodeLinkRegex={ENRICHED_INLINE_FILE_LINK_REGEX}
          containerStyle={{ flexShrink: 1, minWidth: 0 }}
          flavor="github"
          selectable
          selectionColor={props.textStyle.selectionColor}
          selectionHandleColor={props.textStyle.selectionHandleColor}
          md4cFlags={{
            latexMath: false,
            hardSoftBreaks: props.preserveSoftBreaks ?? false,
            admonitions: false,
          }}
          enableTaskListItemToggle={false}
          spoilerOverlay="solid"
          onLinkPress={props.onLinkPress ? ({ url }) => props.onLinkPress?.(url) : undefined}
          onLinkLongPress={onLinkLongPress}
          linkContextMenus={linkContextMenus}
        />
      </View>
    );
  };

  return Platform.OS === "android" && props.fileContextMenu ? (
    <AndroidAnchoredMenu
      title={activeMenu?.menu.title}
      actions={
        activeMenu?.menu.actions.map((action) => ({
          id: action.id,
          title: action.title,
          attributes: { disabled: action.disabled },
        })) ?? []
      }
      onPressAction={({ nativeEvent }) => {
        if (activeMenu) performMenuAction(activeMenu.url, nativeEvent.event);
      }}
      style={{ flexShrink: 1, minWidth: 0 }}
    >
      {renderMarkdown}
    </AndroidAnchoredMenu>
  ) : (
    renderMarkdown()
  );
}

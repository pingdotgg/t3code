import * as Haptics from "expo-haptics";
import { KeyboardAwareLegendList } from "@legendapp/list/keyboard";
import { type LegendListRef } from "@legendapp/list/react-native";
import type { EnvironmentId, MessageId, ThreadId, TurnId } from "@t3tools/contracts";
import { CHAT_LIST_ANCHOR_OFFSET, resolveChatListAnchoredEndSpace } from "@t3tools/shared/chatList";
import { formatElapsed } from "@t3tools/shared/orchestrationTiming";
import { SymbolView } from "../../components/AppSymbol";
import { HeaderHeightContext } from "@react-navigation/elements";
import { useNavigation } from "@react-navigation/native";
import {
  memo,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import {
  Markdown,
  type CustomRenderers,
  type NodeStyleOverrides,
  type PartialMarkdownTheme,
} from "react-native-nitro-markdown";
import {
  ActivityIndicator,
  Image,
  Platform,
  type LayoutChangeEvent,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  Pressable,
  ScrollView,
  StyleSheet,
  Text as NativeText,
  type ColorValue,
  useWindowDimensions,
  View,
} from "react-native";
import { TouchableOpacity } from "react-native-gesture-handler";
import ImageViewing from "react-native-image-viewing";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import Animated, { FadeIn, FadeInUp, type SharedValue } from "react-native-reanimated";
import { useThemeColor } from "../../lib/useThemeColor";
import { IOS_NAV_BAR_HEIGHT } from "../../lib/layoutMetrics";
import { useFontFamily } from "../../lib/useFontFamily";
import { scopedThreadKey } from "../../lib/scopedEntities";
import { copyTextWithHaptic } from "../../lib/copyTextWithHaptic";
import { tryOpenExternalUrl } from "../../lib/openExternalUrl";
import { hasWideMarkdownBlock } from "../../lib/wideMarkdownBlocks";
import {
  hasNativeSelectableMarkdownText,
  SelectableMarkdownText,
  type NativeMarkdownTextStyle,
  type SelectableMarkdownSkill,
} from "../../native/SelectableMarkdownText";

import { AppText as Text } from "../../components/AppText";
import { CopyTextButton } from "../../components/CopyTextButton";
import {
  parseReviewCommentMessageSegments,
  type ReviewInlineComment,
} from "../review/reviewCommentSelection";
import type { ReviewDiffTheme } from "../review/shikiReviewHighlighter";
import { resolveNativeReviewDiffView } from "../diffs/nativeReviewDiffSurface";
import {
  buildNativeReviewDiffData,
  createNativeReviewDiffTheme,
  NATIVE_REVIEW_DIFF_CONTENT_WIDTH,
} from "../review/nativeReviewDiffAdapter";
import { buildReviewParsedDiff } from "../review/reviewModel";
import { cn } from "../../lib/cn";
import { deriveCenteredContentHorizontalPadding, type LayoutVariant } from "../../lib/layout";
import {
  resolveMarkdownFontSizes,
  resolveNativeMarkdownTypography,
  scaledTypographyLineHeight,
} from "../../lib/appearancePreferences";
import { MOBILE_TYPOGRAPHY } from "../../lib/typography";
import { useAppearancePreferences } from "../settings/appearance/AppearancePreferencesProvider";
import { useAppearanceCodeSurface } from "../settings/appearance/useAppearanceCodeSurface";
import { markdownFileIconSource } from "@t3tools/mobile-markdown-text/file-icons";
import { resolveMarkdownLinkPresentation } from "@t3tools/mobile-markdown-text/links";
import {
  deriveThreadFeedPresentation,
  type ThreadFeedEntry,
  type ThreadFeedLatestTurn,
} from "../../lib/threadActivity";
import type { ThreadContentPresentation } from "./threadContentPresentation";
import {
  resolveThreadFeedLiveFollow,
  type ThreadFeedLiveFollowEvent,
} from "./thread-feed-live-follow";
import {
  collapsedWorkLogHeight,
  ThreadWorkGroupToggle,
  ThreadWorkLog,
  WORK_GROUP_TOGGLE_HEIGHT,
} from "./thread-work-log";
import { useMarkdownCodeHighlight } from "./markdownCodeHighlightState";
import { useAssetUrl } from "../../state/assets";
import { resolveWorkspaceRelativeFilePath } from "../files/filePath";

const WIDE_MARKDOWN_BLOCK_OPTIONS = {
  includeOrderedLists: Platform.OS === "android",
} as const;

const MESSAGE_TIME_FORMATTER = new Intl.DateTimeFormat(undefined, {
  hour: "numeric",
  minute: "2-digit",
});
function formatMessageTime(input: string): string {
  const timestamp = Date.parse(input);
  if (Number.isNaN(timestamp)) {
    return "";
  }
  return MESSAGE_TIME_FORMATTER.format(timestamp);
}

// Pre-measurement heights for getFixedItemSize, mirroring renderFeedEntry's
// classNames. The fold row's min-h-11 (44px) stays taller than its single
// text-sm line at every supported base font size (26px at the 22pt maximum),
// so its height is a constant; a drifted value costs one correction on
// measure, not a persistent offset.
const TURN_FOLD_HEIGHT = 56; // min-h-11 (44) + mb-3 (12)
// The working row has no min-height clamp — its height follows the scaled
// text-xs line height (see workingRowHeight in ThreadFeed).
const WORKING_ROW_VERTICAL_EXTRAS = 24; // py-1 (8) + mb-4 (16)

// Entering animations must only play for rows born just now — LegendList
// remounts rows when they scroll back into view, and replaying an entrance for
// old content would be its own kind of jank.
const FRESH_ENTRY_WINDOW_MS = 3_000;
function isFreshTimestamp(input: string): boolean {
  const timestamp = Date.parse(input);
  return Number.isFinite(timestamp) && Date.now() - timestamp < FRESH_ENTRY_WINDOW_MS;
}

export interface ThreadFeedProps {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly workspaceRoot?: string | null;
  readonly feed: ReadonlyArray<ThreadFeedEntry>;
  readonly contentPresentation: ThreadContentPresentation;
  readonly agentLabel: string;
  readonly latestTurn: ThreadFeedLatestTurn | null;
  readonly activeWorkStartedAt: string | null;
  readonly listRef: RefObject<LegendListRef | null>;
  readonly freeze: SharedValue<boolean>;
  readonly anchorMessageId: MessageId | null;
  readonly contentInsetEndAdjustment: SharedValue<number>;
  readonly contentTopInset?: number;
  readonly contentBottomInset?: number;
  readonly contentMaxWidth?: number;
  readonly layoutVariant?: LayoutVariant;
  readonly usesAutomaticContentInsets?: boolean;
  readonly onHeaderMaterialVisibilityChange?: (visible: boolean) => void;
  readonly onEndFollowEnabledChange?: (enabled: boolean) => void;
  readonly skills?: ReadonlyArray<SelectableMarkdownSkill>;
  /** Non-null when older turns exist beyond the loaded window. */
  readonly loadEarlier?: {
    readonly loading: boolean;
    readonly onLoadEarlier: () => void;
  } | null;
}

function MessageAttachmentImage(props: {
  readonly environmentId: EnvironmentId;
  readonly attachmentId: string;
  readonly className: string;
  readonly onPressImage: (uri: string, headers?: Record<string, string>) => void;
}) {
  const uri = useAssetUrl(props.environmentId, {
    _tag: "attachment",
    attachmentId: props.attachmentId,
  });

  if (uri === null) {
    return (
      <View className={`${props.className} items-center justify-center`}>
        <ActivityIndicator />
      </View>
    );
  }

  return (
    <TouchableOpacity activeOpacity={0.7} onPress={() => props.onPressImage(uri)}>
      <Image source={{ uri }} className={props.className} resizeMode="cover" />
    </TouchableOpacity>
  );
}

const MARKDOWN_MONO_FONT = Platform.select({
  ios: "ui-monospace",
  android: "monospace",
  default: "monospace",
});

interface MarkdownStyleSets {
  readonly user: MarkdownStyleSet;
  readonly assistant: MarkdownStyleSet;
}

interface MarkdownStyleSet {
  readonly theme: PartialMarkdownTheme;
  readonly styles: NodeStyleOverrides;
  readonly renderers: CustomRenderers;
  readonly nativeTextStyle: NativeMarkdownTextStyle;
}

interface ReviewCommentColors {
  readonly background: ColorValue;
  readonly border: ColorValue;
  readonly mutedBackground: ColorValue;
  readonly text: ColorValue;
  readonly mutedText: ColorValue;
  readonly codeBackground: ColorValue;
}

const failedMarkdownFaviconHosts = new Set<string>();
const markdownLinkStyles = StyleSheet.create({
  inlineIcon: {
    width: 14,
    height: 14,
    marginHorizontal: 3,
    transform: [{ translateY: 2 }],
  },
  favicon: {
    borderRadius: 3,
  },
});

const MarkdownExternalLink = memo(function MarkdownExternalLink(props: {
  readonly children: ReactNode;
  readonly color: string;
  readonly host: string;
  readonly href: string;
}) {
  const [failed, setFailed] = useState(() => failedMarkdownFaviconHosts.has(props.host));

  return (
    <NativeText
      className="font-sans"
      onPress={() => {
        void tryOpenExternalUrl(props.href, "markdown-link");
      }}
      style={{
        color: props.color,
        textDecorationLine: "none",
      }}
    >
      {!failed ? (
        <Image
          source={{
            uri: `https://www.google.com/s2/favicons?domain=${encodeURIComponent(props.host)}&sz=32`,
          }}
          style={[markdownLinkStyles.inlineIcon, markdownLinkStyles.favicon]}
          onError={() => {
            failedMarkdownFaviconHosts.add(props.host);
            setFailed(true);
          }}
        />
      ) : (
        <NativeText style={{ color: props.color }}>{" ◉ "}</NativeText>
      )}
      {props.children}
    </NativeText>
  );
});

function MarkdownCodeBlock(props: {
  readonly backgroundColor: string;
  readonly borderColor: string;
  readonly content: string;
  readonly copyTintColor: ColorValue;
  readonly headerTextColor: string;
  readonly fontSize: number;
  readonly highlightCode: boolean;
  readonly language?: string | null;
  readonly lineHeight: number;
  readonly textColor: string;
  readonly theme: ReviewDiffTheme;
}) {
  const content = props.content.replace(/\n$/, "");
  const languageLabel = props.language?.trim() || "text";
  const highlighted = useMarkdownCodeHighlight({
    code: content,
    enabled: props.highlightCode && Boolean(props.language?.trim()),
    language: props.language,
    theme: props.theme,
  });
  let tokenOffset = 0;

  return (
    <View
      className="my-3 min-w-0 max-w-full self-stretch overflow-hidden rounded-lg border"
      style={{ backgroundColor: props.backgroundColor, borderColor: props.borderColor }}
    >
      <View
        className="flex-row items-center justify-between gap-2 border-b py-1 pr-1.5 pl-3.5"
        style={{ borderBottomColor: props.borderColor }}
      >
        <NativeText
          className="flex-1 font-mono uppercase opacity-70"
          numberOfLines={1}
          style={{
            color: props.headerTextColor,
            fontSize: props.fontSize,
            ...(Platform.OS === "android" ? { includeFontPadding: false } : null),
          }}
        >
          {languageLabel}
        </NativeText>
        <CopyTextButton
          accessibilityLabel="Copy code"
          text={content}
          tintColor={props.copyTintColor}
          buttonSize={32}
          iconSize={16}
        />
      </View>
      <ScrollView
        horizontal
        bounces={false}
        nestedScrollEnabled={Platform.OS === "android"}
        showsHorizontalScrollIndicator={false}
        contentContainerClassName="px-3.5 py-3"
      >
        <NativeText
          selectable
          className="font-mono"
          style={{
            color: props.textColor,
            fontSize: props.fontSize,
            lineHeight: props.lineHeight,
            ...(Platform.OS === "android" ? { includeFontPadding: false } : null),
          }}
        >
          {highlighted
            ? highlighted.map((line, lineIndex) => {
                const lineStartOffset = tokenOffset;
                const lineText = line.map((token) => token.content).join("");
                const renderedLine = (
                  <NativeText key={`line:${lineStartOffset}:${lineText}`}>
                    {line.map((token) => {
                      const startOffset = tokenOffset;
                      tokenOffset += token.content.length;
                      const fontStyle =
                        token.fontStyle !== null && (token.fontStyle & 1) === 1
                          ? ("italic" as const)
                          : ("normal" as const);
                      const fontWeight =
                        token.fontStyle !== null && (token.fontStyle & 2) === 2
                          ? ("700" as const)
                          : ("400" as const);

                      return (
                        <NativeText
                          key={`${startOffset}:${token.content}:${token.color ?? ""}:${
                            token.fontStyle ?? ""
                          }`}
                          style={{
                            color: token.color ?? props.textColor,
                            fontStyle,
                            fontWeight,
                          }}
                        >
                          {token.content}
                        </NativeText>
                      );
                    })}
                    {lineIndex + 1 < highlighted.length ? "\n" : ""}
                  </NativeText>
                );
                if (lineIndex + 1 < highlighted.length) {
                  tokenOffset += 1;
                }
                return renderedLine;
              })
            : content}
        </NativeText>
      </ScrollView>
    </View>
  );
}

function useReviewCommentColors(): ReviewCommentColors {
  const background = useThemeColor("--color-card");
  const border = useThemeColor("--color-border");
  const mutedBackground = useThemeColor("--color-subtle");
  const text = useThemeColor("--color-foreground");
  const mutedText = useThemeColor("--color-foreground-muted");
  const codeBackground = useThemeColor("--color-md-code-bg");

  return useMemo(
    () => ({
      background,
      border,
      mutedBackground,
      text,
      mutedText,
      codeBackground,
    }),
    [background, border, codeBackground, mutedBackground, mutedText, text],
  );
}

function useMarkdownStyles(onLinkPress: (href: string) => void): MarkdownStyleSets {
  const { appearance, themeAppearance } = useAppearancePreferences();
  const markdownFontSizes = useMemo(
    () => resolveMarkdownFontSizes(appearance.baseFontSize),
    [appearance.baseFontSize],
  );
  const nativeMarkdownTypography = useMemo(
    () => resolveNativeMarkdownTypography(appearance.baseFontSize),
    [appearance.baseFontSize],
  );
  const themeMode = themeAppearance;
  const markdownBodyColor = String(useThemeColor("--color-md-body"));
  const markdownStrongColor = String(useThemeColor("--color-md-strong"));
  const markdownLinkColor = String(useThemeColor("--color-md-link"));
  const markdownBlockquoteBg = String(useThemeColor("--color-md-blockquote-bg"));
  const markdownBlockquoteBorder = String(useThemeColor("--color-md-blockquote-border"));
  const markdownCodeBg = String(useThemeColor("--color-md-code-bg"));
  const markdownCodeText = String(useThemeColor("--color-md-code-text"));
  const markdownInlineCodeText = String(useThemeColor("--color-foreground-secondary"));
  const markdownHrColor = String(useThemeColor("--color-md-hr"));
  const markdownUserBodyColor = String(useThemeColor("--color-user-bubble-foreground"));
  const markdownUserCodeBg = String(useThemeColor("--color-md-user-code-bg"));
  const markdownUserCodeText = String(useThemeColor("--color-md-user-code-text"));
  const markdownUserInlineCodeText = String(useThemeColor("--color-user-bubble-foreground-muted"));
  const markdownUserFenceBg = String(useThemeColor("--color-md-user-fence-bg"));
  const markdownUserFenceText = String(useThemeColor("--color-md-user-fence-text"));
  const iconSubtleColor = String(useThemeColor("--color-icon-subtle"));
  const inlineSkillForeground = String(useThemeColor("--color-inline-skill-foreground"));
  const userBubbleSkillForeground = String(useThemeColor("--color-user-bubble-skill-foreground"));
  const userBubbleForegroundMuted = String(useThemeColor("--color-user-bubble-foreground-muted"));
  const regularFontFamily = useFontFamily("regular");
  const boldFontFamily = useFontFamily("bold");

  return useMemo(() => {
    const baseTheme: PartialMarkdownTheme = {
      colors: {
        text: markdownBodyColor,
        heading: markdownStrongColor,
        link: markdownLinkColor,
        blockquote: markdownBlockquoteBorder,
        border: markdownHrColor,
        surface: "transparent",
        surfaceLight: markdownBlockquoteBg,
        accent: markdownLinkColor,
        tableBorder: markdownHrColor,
        tableHeader: markdownBlockquoteBg,
        tableHeaderText: markdownStrongColor,
        tableRowOdd: "transparent",
        tableRowEven: "transparent",
      },
      spacing: {
        xs: 4,
        s: 4,
        m: 8,
        l: 8,
        xl: 16,
      },
      fontSizes: {
        s: markdownFontSizes.s,
        m: markdownFontSizes.m,
        h1: markdownFontSizes.h1,
        h2: markdownFontSizes.h2,
        h3: markdownFontSizes.h3,
        h4: markdownFontSizes.h4,
        h5: markdownFontSizes.h5,
        h6: markdownFontSizes.h6,
      },
      fontFamilies: {
        regular: regularFontFamily,
        heading: boldFontFamily,
        mono: MARKDOWN_MONO_FONT,
      },
      headingWeight: "700",
      borderRadius: {
        s: 4,
        m: 8,
        l: 12,
      },
      showCodeLanguage: false,
    };

    const baseStyles: NodeStyleOverrides = {
      document: { flexShrink: 1 },
      paragraph: { marginTop: 0, marginBottom: 10 },
      list: { marginTop: 4, marginBottom: 8 },
      list_item: { marginTop: 0, marginBottom: 4 },
      task_list_item: { marginTop: 0, marginBottom: 4 },
      text: { lineHeight: markdownFontSizes.bodyLineHeight },
      bold: {
        fontWeight: "700",
        color: markdownStrongColor,
        fontFamily: boldFontFamily,
      },
      italic: { fontStyle: "italic" },
      link: {
        color: markdownLinkColor,
        textDecorationLine: "underline" as const,
      },
      blockquote: {
        borderLeftWidth: 2,
        borderLeftColor: markdownBlockquoteBorder,
        paddingLeft: 11,
        paddingVertical: 2,
        marginLeft: 0,
        marginVertical: 10,
      },
      heading: {
        fontFamily: boldFontFamily,
        color: markdownStrongColor,
        marginTop: 18,
        marginBottom: 8,
      },
      horizontal_rule: {
        backgroundColor: markdownHrColor,
        height: 1,
        marginVertical: 12,
      },
    };

    const createMarkdownRenderers = (
      inlineTextColor: string,
      inlineCodeTextColor: string,
      blockBackgroundColor: string,
      blockTextColor: string,
      copyTintColor: ColorValue,
      preserveSoftBreaks: boolean,
      highlightCode: boolean,
    ): CustomRenderers => ({
      link: ({ children, href = "" }) => {
        const presentation = resolveMarkdownLinkPresentation(href);
        if (presentation.kind === "file") {
          return (
            <NativeText
              className="font-t3-bold"
              onPress={() => onLinkPress(href)}
              style={{ color: inlineTextColor }}
            >
              <Image
                source={markdownFileIconSource(presentation.icon)}
                style={markdownLinkStyles.inlineIcon}
              />
              {presentation.label}
            </NativeText>
          );
        }
        if (presentation.kind === "external") {
          return (
            <MarkdownExternalLink
              href={presentation.href}
              host={presentation.host}
              color={markdownLinkColor}
            >
              {children}
            </MarkdownExternalLink>
          );
        }
        const linkHref = presentation.href;
        return (
          <NativeText
            className="underline"
            onPress={
              linkHref
                ? () => {
                    void tryOpenExternalUrl(linkHref, "markdown-link");
                  }
                : undefined
            }
            style={{ color: markdownLinkColor }}
          >
            {children}
          </NativeText>
        );
      },
      list: ({ node, Renderer, ordered = false, start = 1 }) => (
        <View className="mt-0.5 mb-2">
          {node.children?.map((child, index) => {
            const childKey = `${child.type}:${child.beg ?? "unknown"}:${child.end ?? "unknown"}`;
            if (child.type === "task_list_item") {
              return (
                <Renderer key={childKey} node={child} depth={1} inListItem parentIsText={false} />
              );
            }
            return (
              <View className="mb-[3px] flex-row items-start" key={childKey}>
                <NativeText
                  className="font-sans"
                  style={{
                    width: ordered ? 22 : 12,
                    marginRight: 5,
                    color: inlineTextColor,
                    fontSize: markdownFontSizes.m,
                    lineHeight: markdownFontSizes.bodyLineHeight,
                    textAlign: ordered ? "right" : "center",
                  }}
                >
                  {ordered ? `${start + index}.` : "•"}
                </NativeText>
                <View className="min-w-0 flex-1">
                  <Renderer node={child} depth={1} inListItem parentIsText={false} />
                </View>
              </View>
            );
          })}
        </View>
      ),
      code_inline: ({ content }) => {
        const value = content ?? "";
        return (
          <NativeText
            className="font-mono"
            style={{
              color: inlineCodeTextColor,
              fontSize: markdownFontSizes.codeBlockFontSize,
              lineHeight: markdownFontSizes.bodyLineHeight,
            }}
          >
            {value}
          </NativeText>
        );
      },
      ...(preserveSoftBreaks
        ? {
            soft_break: () => <NativeText>{"\n"}</NativeText>,
          }
        : {}),
      code_block: ({ content = "", language }) => (
        <MarkdownCodeBlock
          backgroundColor={blockBackgroundColor}
          borderColor={markdownHrColor}
          content={content}
          copyTintColor={copyTintColor}
          fontSize={markdownFontSizes.codeBlockFontSize}
          headerTextColor={blockTextColor}
          highlightCode={highlightCode}
          language={language}
          lineHeight={markdownFontSizes.codeBlockLineHeight}
          textColor={blockTextColor}
          theme={themeMode}
        />
      ),
    });

    const userTheme: PartialMarkdownTheme = {
      ...baseTheme,
      colors: {
        ...baseTheme.colors,
        text: markdownUserBodyColor,
        heading: markdownUserBodyColor,
        link: markdownUserBodyColor,
        code: markdownUserCodeText,
        codeBackground: markdownUserCodeBg,
        border: markdownUserFenceBg,
      },
    };
    const userStyles: NodeStyleOverrides = {
      ...baseStyles,
      paragraph: { marginTop: 0, marginBottom: 0 },
      bold: {
        fontWeight: "700",
        color: markdownUserBodyColor,
        fontFamily: boldFontFamily,
      },
      heading: {
        ...baseStyles.heading,
        color: markdownUserBodyColor,
        marginTop: 8,
        marginBottom: 4,
      },
      link: {
        color: markdownUserBodyColor,
        textDecorationLine: "underline" as const,
      },
    };

    const assistantTheme: PartialMarkdownTheme = {
      ...baseTheme,
      colors: {
        ...baseTheme.colors,
        code: markdownCodeText,
        codeBackground: markdownCodeBg,
        border: markdownCodeBg,
      },
    };
    const assistantStyles: NodeStyleOverrides = {
      ...baseStyles,
    };

    return {
      user: {
        theme: userTheme,
        styles: userStyles,
        renderers: createMarkdownRenderers(
          markdownUserCodeText,
          markdownUserInlineCodeText,
          markdownUserFenceBg,
          markdownUserFenceText,
          userBubbleForegroundMuted,
          true,
          false,
        ),
        nativeTextStyle: {
          color: markdownUserBodyColor,
          strongColor: markdownUserBodyColor,
          mutedColor: markdownUserBodyColor,
          linkColor: markdownUserBodyColor,
          inlineCodeColor: markdownUserInlineCodeText,
          codeColor: markdownUserCodeText,
          codeBackgroundColor: markdownUserCodeBg,
          codeBlockBackgroundColor: markdownUserFenceBg,
          fileTextColor: markdownUserBodyColor,
          skillTextColor: userBubbleSkillForeground,
          quoteMarkerColor: markdownUserBodyColor,
          dividerColor: markdownUserBodyColor,
          fontSize: nativeMarkdownTypography.fontSize,
          lineHeight: nativeMarkdownTypography.lineHeight,
          headingFontSizes: nativeMarkdownTypography.headingFontSizes,
          fontFamily: regularFontFamily,
          headingFontFamily: boldFontFamily,
          boldFontFamily,
        },
      },
      assistant: {
        theme: assistantTheme,
        styles: assistantStyles,
        renderers: createMarkdownRenderers(
          markdownCodeText,
          markdownInlineCodeText,
          markdownCodeBg,
          markdownCodeText,
          iconSubtleColor,
          false,
          true,
        ),
        nativeTextStyle: {
          color: markdownBodyColor,
          strongColor: markdownStrongColor,
          mutedColor: markdownBodyColor,
          linkColor: markdownLinkColor,
          inlineCodeColor: markdownInlineCodeText,
          codeColor: markdownCodeText,
          codeBackgroundColor: markdownCodeBg,
          codeBlockBackgroundColor: markdownCodeBg,
          fileTextColor: markdownCodeText,
          skillTextColor: inlineSkillForeground,
          quoteMarkerColor: markdownBlockquoteBorder,
          dividerColor: markdownHrColor,
          fontSize: nativeMarkdownTypography.fontSize,
          lineHeight: nativeMarkdownTypography.lineHeight,
          headingFontSizes: nativeMarkdownTypography.headingFontSizes,
          fontFamily: regularFontFamily,
          headingFontFamily: boldFontFamily,
          boldFontFamily,
        },
      },
    };
  }, [
    boldFontFamily,
    iconSubtleColor,
    inlineSkillForeground,
    markdownBlockquoteBg,
    markdownBlockquoteBorder,
    markdownBodyColor,
    markdownCodeBg,
    markdownCodeText,
    markdownFontSizes,
    markdownHrColor,
    markdownInlineCodeText,
    markdownLinkColor,
    markdownStrongColor,
    markdownUserBodyColor,
    markdownUserCodeBg,
    markdownUserCodeText,
    markdownUserFenceBg,
    markdownUserFenceText,
    markdownUserInlineCodeText,
    nativeMarkdownTypography,
    onLinkPress,
    regularFontFamily,
    themeMode,
    userBubbleForegroundMuted,
    userBubbleSkillForeground,
  ]);
}

function renderFeedEntry(
  info: { item: ThreadFeedEntry; index: number },
  props: Pick<ThreadFeedProps, "environmentId" | "skills"> & {
    readonly copiedRowId: string | null;
    readonly expandedWorkRows: Record<string, boolean>;
    readonly terminalAssistantMessageIds: ReadonlySet<string>;
    readonly unsettledTurnId: TurnId | null;
    readonly onCopyWorkRow: (rowId: string, value: string) => void;
    readonly onToggleWorkGroup: (groupId: string) => void;
    readonly onToggleWorkRow: (rowId: string) => void;
    readonly onToggleTurnFold: (turnId: TurnId) => void;
    readonly onPressImage: (uri: string, headers?: Record<string, string>) => void;
    readonly onMarkdownLinkPress: (href: string) => void;
    readonly iconSubtleColor: string | import("react-native").ColorValue;
    readonly userBubbleColor: string | import("react-native").ColorValue;
    readonly markdownStyles: MarkdownStyleSets;
    readonly reviewCommentColors: ReviewCommentColors;
    readonly reviewCommentBubbleWidth: number;
    readonly userBubbleMaxWidth: number;
  },
) {
  const entry = info.item;
  const { markdownStyles, iconSubtleColor, userBubbleColor } = props;

  if (entry.type === "working") {
    return <WorkingTimelineRow startedAt={entry.createdAt} />;
  }

  if (entry.type === "turn-fold") {
    return (
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: entry.expanded }}
        onPress={() => props.onToggleTurnFold(entry.turnId)}
        hitSlop={4}
        className="mb-3 min-h-11 flex-row items-center gap-2 border-b border-neutral-200/80 px-2 dark:border-white/[0.08]"
      >
        <Text className="font-t3-medium text-sm tabular-nums text-foreground-muted">
          {entry.label}
        </Text>
        <SymbolView
          name={entry.expanded ? "chevron.down" : "chevron.right"}
          size={15}
          tintColor={iconSubtleColor}
          type="monochrome"
        />
      </Pressable>
    );
  }

  if (entry.type === "work-toggle") {
    return (
      <ThreadWorkGroupToggle
        expanded={entry.expanded}
        hiddenCount={entry.hiddenCount}
        iconSubtleColor={iconSubtleColor}
        onlyToolActivities={entry.onlyToolActivities}
        onToggle={() => props.onToggleWorkGroup(entry.groupId)}
      />
    );
  }

  if (entry.type === "message") {
    const { message } = entry;
    const isUser = message.role === "user";
    const styles = isUser ? markdownStyles.user : markdownStyles.assistant;
    const timestampLabel = formatMessageTime(isUser ? message.createdAt : message.updatedAt);
    const attachments = message.attachments ?? [];
    const hasReviewCommentContext = message.text.includes("<review_comment");
    // A bubble that sizes itself from its content cannot lay out a block whose
    // intrinsic width overflows `maxWidth`: Android positions the bubble's
    // children during the unclamped pass and never moves them once the width
    // is clamped, so the paragraphs around the block end up drawn on top of
    // each other. Pinning the width removes that pass.
    const hasWideBlock = hasWideMarkdownBlock(message.text, WIDE_MARKDOWN_BLOCK_OPTIONS);
    const assistantTurnStillInProgress =
      message.role === "assistant" &&
      props.unsettledTurnId !== null &&
      message.turnId === props.unsettledTurnId;
    const showAssistantMeta =
      message.role === "assistant" &&
      props.terminalAssistantMessageIds.has(message.id) &&
      !assistantTurnStillInProgress &&
      !message.streaming;

    if (isUser) {
      const enterAnimated = isFreshTimestamp(message.createdAt);
      return (
        <Animated.View
          className="mb-5 items-end"
          {...(enterAnimated ? { entering: FadeInUp.duration(220) } : {})}
        >
          <View
            className="min-w-0 gap-2 rounded-[20px] px-3.5 py-2.5"
            style={{
              backgroundColor: userBubbleColor,
              maxWidth: props.userBubbleMaxWidth,
              ...(hasReviewCommentContext
                ? { width: props.reviewCommentBubbleWidth }
                : hasWideBlock
                  ? { width: props.userBubbleMaxWidth }
                  : null),
            }}
          >
            {message.text.trim().length > 0 ? (
              <UserMessageContent
                text={message.text}
                markdownStyles={styles}
                reviewCommentColors={props.reviewCommentColors}
                skills={props.skills}
                onLinkPress={props.onMarkdownLinkPress}
              />
            ) : null}
            {attachments.map((attachment) => {
              return (
                <MessageAttachmentImage
                  key={attachment.id}
                  environmentId={props.environmentId}
                  attachmentId={attachment.id}
                  className="aspect-[1.3] w-full rounded-[14px] bg-white/15"
                  onPressImage={props.onPressImage}
                />
              );
            })}
          </View>
          <View className="mt-1 flex-row items-center justify-end gap-1 pr-0.5">
            <Text className="font-t3-medium text-xs tabular-nums text-neutral-600 dark:text-neutral-400">
              {timestampLabel}
            </Text>
            {message.text.trim().length > 0 ? (
              <CopyTextButton
                accessibilityLabel="Copy message"
                text={message.text}
                tintColor={iconSubtleColor}
                buttonSize={28}
                iconSize={13}
              />
            ) : null}
          </View>
        </Animated.View>
      );
    }

    // Skip empty assistant messages (no text, no attachments) — they would
    // render as an orphaned timestamp and break adjacent activity-group merging.
    if (message.text.trim().length === 0 && attachments.length === 0) {
      return null;
    }

    const enterAnimated = isFreshTimestamp(message.createdAt);
    return (
      <Animated.View
        className={cn(showAssistantMeta ? "mb-5 px-1" : "mb-2 px-1")}
        {...(enterAnimated ? { entering: FadeIn.duration(220) } : {})}
      >
        {message.text.trim().length > 0 ? (
          hasNativeSelectableMarkdownText() ? (
            <SelectableMarkdownText
              markdown={message.text}
              skills={props.skills}
              textStyle={styles.nativeTextStyle}
              onLinkPress={props.onMarkdownLinkPress}
            />
          ) : (
            <Markdown
              options={{ gfm: true }}
              renderers={styles.renderers}
              styles={styles.styles}
              theme={styles.theme}
            >
              {message.text}
            </Markdown>
          )
        ) : null}
        {attachments.map((attachment) => {
          return (
            <MessageAttachmentImage
              key={attachment.id}
              environmentId={props.environmentId}
              attachmentId={attachment.id}
              className="mt-1.5 aspect-[1.3] w-full rounded-[18px] bg-neutral-200 dark:bg-neutral-800"
              onPressImage={props.onPressImage}
            />
          );
        })}
        {showAssistantMeta ? (
          <View className="mt-1 flex-row items-center gap-1">
            <CopyTextButton
              accessibilityLabel="Copy message"
              text={message.text}
              tintColor={iconSubtleColor}
              buttonSize={28}
              iconSize={13}
            />
            <Text className="font-t3-medium text-xs tabular-nums text-neutral-600 dark:text-neutral-400">
              {timestampLabel}
            </Text>
          </View>
        ) : null}
      </Animated.View>
    );
  }

  return (
    <ThreadWorkLog
      activities={entry.activities}
      copiedRowId={props.copiedRowId}
      expandedRows={props.expandedWorkRows}
      iconSubtleColor={iconSubtleColor}
      onCopyRow={props.onCopyWorkRow}
      onToggleRow={props.onToggleWorkRow}
    />
  );
}

const WorkingTimelineRow = memo(function WorkingTimelineRow(props: { readonly startedAt: string }) {
  const [nowMs, setNowMs] = useState(() => Date.now());

  useEffect(() => {
    const intervalId = setInterval(() => {
      setNowMs(Date.now());
    }, 1_000);
    return () => clearInterval(intervalId);
  }, [props.startedAt]);

  const durationLabel = formatElapsed(props.startedAt, new Date(nowMs).toISOString()) ?? "0s";

  return (
    <View className="mb-4 flex-row items-center gap-2 px-1.5 py-1">
      <View className="flex-row items-center gap-1">
        <View className="h-1 w-1 rounded-full bg-neutral-400 dark:bg-neutral-500" />
        <View className="h-1 w-1 rounded-full bg-neutral-400/80 dark:bg-neutral-500/80" />
        <View className="h-1 w-1 rounded-full bg-neutral-400/60 dark:bg-neutral-500/60" />
      </View>
      <Text className="font-t3-medium text-xs tabular-nums text-neutral-600 dark:text-neutral-400">
        Working for {durationLabel}
      </Text>
    </View>
  );
});

function UserMessageContent(props: {
  readonly text: string;
  readonly markdownStyles: MarkdownStyleSet;
  readonly reviewCommentColors: ReviewCommentColors;
  readonly skills?: ReadonlyArray<SelectableMarkdownSkill>;
  readonly onLinkPress: (href: string) => void;
}) {
  const segments = parseReviewCommentMessageSegments(props.text);
  const hasReviewComment = segments.some((segment) => segment.kind === "review-comment");
  if (!hasReviewComment) {
    if (hasNativeSelectableMarkdownText()) {
      return (
        <SelectableMarkdownText
          markdown={props.text}
          skills={props.skills}
          textStyle={props.markdownStyles.nativeTextStyle}
          preserveSoftBreaks
          onLinkPress={props.onLinkPress}
        />
      );
    }
    return (
      <Markdown
        options={{ gfm: true }}
        renderers={props.markdownStyles.renderers}
        styles={props.markdownStyles.styles}
        theme={props.markdownStyles.theme}
      >
        {props.text}
      </Markdown>
    );
  }

  return (
    <View className="w-full gap-2">
      {segments.map((segment) => {
        if (segment.kind === "review-comment") {
          return (
            <ReviewCommentCard
              key={segment.comment.id}
              comment={segment.comment}
              colors={props.reviewCommentColors}
            />
          );
        }

        const text = segment.text.trim();
        if (text.length === 0) {
          return null;
        }

        return hasNativeSelectableMarkdownText() ? (
          <SelectableMarkdownText
            key={segment.id}
            markdown={text}
            skills={props.skills}
            textStyle={props.markdownStyles.nativeTextStyle}
            preserveSoftBreaks
            onLinkPress={props.onLinkPress}
          />
        ) : (
          <Markdown
            key={segment.id}
            options={{ gfm: true }}
            renderers={props.markdownStyles.renderers}
            styles={props.markdownStyles.styles}
            theme={props.markdownStyles.theme}
          >
            {text}
          </Markdown>
        );
      })}
    </View>
  );
}

const ReviewCommentCard = memo(function ReviewCommentCard(props: {
  readonly comment: ReviewInlineComment;
  readonly colors: ReviewCommentColors;
}) {
  const { codeSurface, nativeReviewDiffStyle } = useAppearanceCodeSurface();
  const { themeAppearance: appearanceScheme, themeId } = useAppearancePreferences();
  const NativeReviewDiffView = resolveNativeReviewDiffView();
  const patch = useMemo(() => buildReviewCommentPatch(props.comment), [props.comment]);
  const parsedDiff = useMemo(
    () => buildReviewParsedDiff(patch, `thread-review-comment:${props.comment.id}`),
    [patch, props.comment.id],
  );
  const nativeReviewDiffData = useMemo(() => buildNativeReviewDiffData(parsedDiff), [parsedDiff]);
  const compactNativeRows = useMemo(
    () => nativeReviewDiffData.rows.filter((row) => row.kind !== "file"),
    [nativeReviewDiffData.rows],
  );
  const nativeReviewDiffTheme = useMemo(
    () => createNativeReviewDiffTheme(appearanceScheme, themeId),
    [appearanceScheme, themeId],
  );
  const nativeRowsJson = useMemo(() => JSON.stringify(compactNativeRows), [compactNativeRows]);
  const nativeThemeJson = useMemo(
    () => JSON.stringify(nativeReviewDiffTheme),
    [nativeReviewDiffTheme],
  );
  const nativeStyleJson = useMemo(
    () => JSON.stringify(nativeReviewDiffStyle),
    [nativeReviewDiffStyle],
  );
  const nativeDiffHeight = useMemo(
    () =>
      Math.min(
        360,
        Math.max(
          112,
          compactNativeRows.length * nativeReviewDiffStyle.rowHeight +
            nativeReviewDiffStyle.fileHeaderVerticalMargin,
        ),
      ),
    [compactNativeRows.length, nativeReviewDiffStyle],
  );
  const shouldRenderNativeDiff = NativeReviewDiffView != null && compactNativeRows.length > 0;

  return (
    <View
      className="w-full overflow-hidden rounded-[16px] border border-continuous"
      style={{
        backgroundColor: props.colors.background,
        borderColor: props.colors.border,
      }}
    >
      <View
        className="flex-row items-center gap-2 border-b px-3 py-2"
        style={{ borderColor: props.colors.border }}
      >
        <View
          className="size-6 items-center justify-center rounded-[7px] border-continuous"
          style={{ backgroundColor: props.colors.mutedBackground }}
        >
          <SymbolView
            name="doc.text"
            size={13}
            tintColor={props.colors.mutedText}
            type="monochrome"
          />
        </View>
        <View className="min-w-0 flex-1">
          <Text
            className="font-mono text-xs"
            numberOfLines={1}
            style={{ color: props.colors.text }}
          >
            {compactFileName(props.comment.filePath)}
          </Text>
        </View>
      </View>
      {shouldRenderNativeDiff ? (
        <View
          className="border-t"
          collapsable={false}
          style={{
            backgroundColor: nativeReviewDiffTheme.background,
            borderColor: props.colors.border,
            height: nativeDiffHeight,
          }}
        >
          <NativeReviewDiffView
            collapsable={false}
            style={StyleSheet.absoluteFill}
            appearanceScheme={appearanceScheme}
            contentWidth={NATIVE_REVIEW_DIFF_CONTENT_WIDTH}
            rowHeight={nativeReviewDiffStyle.rowHeight}
            rowsJson={nativeRowsJson}
            styleJson={nativeStyleJson}
            themeJson={nativeThemeJson}
          />
        </View>
      ) : props.comment.diff.trim().length > 0 ? (
        <ScrollView
          horizontal
          nestedScrollEnabled
          directionalLockEnabled
          showsHorizontalScrollIndicator={false}
          bounces={false}
          className="border-t"
          style={{ backgroundColor: props.colors.codeBackground, borderColor: props.colors.border }}
          contentContainerStyle={{ padding: 10 }}
        >
          <NativeText
            selectable
            className="font-mono"
            style={{
              color: props.colors.text,
              fontSize: codeSurface.fontSize,
              lineHeight: codeSurface.rowHeight,
            }}
          >
            {props.comment.diff.trim()}
          </NativeText>
        </ScrollView>
      ) : null}
      {props.comment.text.length > 0 ? (
        <View className="border-t px-3 py-3" style={{ borderColor: props.colors.border }}>
          <Text selectable className="text-base leading-snug" style={{ color: props.colors.text }}>
            {props.comment.text}
          </Text>
        </View>
      ) : null}
    </View>
  );
});

function buildReviewCommentPatch(comment: ReviewInlineComment): string {
  if ((comment.fenceLanguage ?? "diff") !== "diff") {
    return "";
  }
  const diff = comment.diff.trim();
  if (!diff) {
    return "";
  }

  if (diff.startsWith("diff --git ")) {
    return diff;
  }

  const normalizedPath = comment.filePath.replaceAll("\\", "/");
  return [
    `diff --git a/${normalizedPath} b/${normalizedPath}`,
    `--- a/${normalizedPath}`,
    `+++ b/${normalizedPath}`,
    diff,
  ].join("\n");
}

function compactFileName(filePath: string): string {
  const normalized = filePath.replaceAll("\\", "/");
  const lastSlashIndex = normalized.lastIndexOf("/");
  return lastSlashIndex >= 0 ? normalized.slice(lastSlashIndex + 1) : normalized;
}

function ThreadFeedPlaceholder(props: {
  readonly bottomInset: number;
  readonly detail: string;
  readonly horizontalPadding: number;
  readonly title: string;
  readonly topInset: number;
}) {
  return (
    <View
      style={{
        flex: 1,
        flexGrow: 1,
        alignItems: "center",
        justifyContent: "center",
        paddingTop: props.topInset,
        paddingBottom: props.bottomInset,
        paddingHorizontal: props.horizontalPadding + 24,
      }}
    >
      <View className="max-w-[320px] items-center gap-2">
        <Text className="text-center font-t3-bold text-lg text-foreground">{props.title}</Text>
        <Text className="text-center text-sm leading-normal text-foreground-secondary">
          {props.detail}
        </Text>
      </View>
    </View>
  );
}

export const ThreadFeed = memo(function ThreadFeed(props: ThreadFeedProps) {
  const navigation = useNavigation();
  const copyFeedbackTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const foldSettleFrameRef = useRef<number | null>(null);
  const foldSettleSecondFrameRef = useRef<number | null>(null);
  const disclosureAnchorKeyRef = useRef<string | null>(null);
  const headerMaterialVisibleRef = useRef(false);
  const previousLatestTurnRef = useRef(props.latestTurn);
  const userScrollSettleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const { width: windowWidth } = useWindowDimensions();
  const { appearance } = useAppearancePreferences();
  const [viewportWidth, setViewportWidth] = useState(() =>
    props.layoutVariant === "split" ? 0 : windowWidth,
  );
  const [viewportHeight, setViewportHeight] = useState(0);
  const [disclosureToggleSettling, setDisclosureToggleSettling] = useState(false);
  // Live-follow latch. LegendList's maintainScrollAtEnd alone re-pins the feed
  // whenever the viewport drifts back inside its geometric threshold, which
  // yanked users off history they were reading every time a stream chunk grew
  // a row. Follow breaks when the user scrolls up and away, and re-arms only
  // when the list actually returns to the end (or on send / thread switch).
  const [endFollowEnabled, setEndFollowEnabled] = useState(true);
  const endFollowEnabledRef = useRef(true);
  // A "user scroll session" spans from drag start through the end of its
  // momentum; only motion inside a session can break follow, so MVCP
  // compensations and programmatic scrolls never strand a follower.
  const userScrollSessionRef = useRef(false);
  const setEndFollow = useCallback(
    (enabled: boolean) => {
      if (endFollowEnabledRef.current === enabled) {
        return;
      }
      endFollowEnabledRef.current = enabled;
      setEndFollowEnabled(enabled);
      props.onEndFollowEnabledChange?.(enabled);
    },
    [props.onEndFollowEnabledChange],
  );
  const transitionEndFollow = useCallback(
    (event: ThreadFeedLiveFollowEvent) => {
      setEndFollow(resolveThreadFeedLiveFollow(endFollowEnabledRef.current, event));
    },
    [setEndFollow],
  );
  const [interactionState, setInteractionState] = useState<{
    readonly copiedRowId: string | null;
    readonly expandedWorkGroups: Record<string, boolean>;
    readonly expandedWorkRows: Record<string, boolean>;
    readonly expandedTurnIds: ReadonlySet<TurnId>;
  }>({
    copiedRowId: null,
    expandedWorkGroups: {},
    expandedWorkRows: {},
    expandedTurnIds: new Set(),
  });
  const { copiedRowId, expandedWorkGroups, expandedWorkRows, expandedTurnIds } = interactionState;
  const [expandedImage, setExpandedImage] = useState<{
    uri: string;
    headers?: Record<string, string>;
  } | null>(null);
  const horizontalPadding = props.layoutVariant === "split" ? 20 : 16;
  const contentHorizontalPadding = deriveCenteredContentHorizontalPadding({
    viewportWidth,
    maxContentWidth: props.contentMaxWidth ?? null,
    minimumPadding: horizontalPadding,
  });
  const contentWidth = Math.max(0, viewportWidth - contentHorizontalPadding * 2);
  const userBubbleMaxWidth = contentWidth * 0.85;
  const reviewCommentBubbleWidth = Math.min(Math.max(280, contentWidth * 0.85), contentWidth);
  const insets = useSafeAreaInsets();
  const topContentInset = props.contentTopInset ?? insets.top + IOS_NAV_BAR_HEIGHT;
  const bottomContentInset = props.contentBottomInset ?? 18;
  const usesNativeAutomaticInsets =
    props.usesAutomaticContentInsets === true && Platform.OS === "ios";
  // With automatic insets the header inset lives in UIKit's adjustedContentInset,
  // which LegendList's JS anchoring math cannot see — it measures the anchored
  // end space from the scroll view's frame top. Fold the header height back into
  // the anchor offset or a just-sent message anchors underneath the header and
  // the oversized end space keeps maintainScrollAtEnd snapping away from earlier
  // messages. Read the context directly (useHeaderHeight throws outside a
  // header-providing screen) and fall back to the standard iOS bar height.
  const navigationHeaderHeight = useContext(HeaderHeightContext);
  const anchorTopInset = usesNativeAutomaticInsets
    ? navigationHeaderHeight || insets.top + IOS_NAV_BAR_HEIGHT
    : topContentInset;

  const iconSubtleColor = useThemeColor("--color-icon-subtle");
  const userBubbleColor = useThemeColor("--color-user-bubble");
  const onMarkdownLinkPress = useCallback(
    (href: string) => {
      const presentation = resolveMarkdownLinkPresentation(href);
      if (presentation.kind === "file") {
        const relativePath = resolveWorkspaceRelativeFilePath(
          props.workspaceRoot,
          presentation.path,
        );
        if (relativePath) {
          void Haptics.selectionAsync();
          navigation.navigate("ThreadFile", {
            environmentId: String(props.environmentId),
            threadId: String(props.threadId),
            path: relativePath.split("/").filter((segment) => segment.length > 0),
            ...(presentation.line ? { line: String(presentation.line) } : {}),
          });
        }
        return;
      }

      if (presentation.href) {
        void tryOpenExternalUrl(presentation.href, "markdown-link");
      }
    },
    [props.environmentId, props.threadId, props.workspaceRoot, navigation],
  );
  const markdownStyles = useMarkdownStyles(onMarkdownLinkPress);
  const reviewCommentColors = useReviewCommentColors();
  // LegendList does not invalidate visible rows when only the renderItem closure changes.
  // Keep row-local interaction props in extraData so disclosures and copy feedback repaint.
  const listAppearanceData = useMemo(
    () => ({
      copiedRowId,
      expandedWorkRows,
      iconSubtleColor,
      markdownStyles,
      reviewCommentColors,
      userBubbleColor,
      viewportWidth,
    }),
    [
      copiedRowId,
      expandedWorkRows,
      iconSubtleColor,
      markdownStyles,
      reviewCommentColors,
      userBubbleColor,
      viewportWidth,
    ],
  );
  const reportHeaderMaterialVisibility = useCallback(
    (visible: boolean) => {
      if (headerMaterialVisibleRef.current === visible) {
        return;
      }
      headerMaterialVisibleRef.current = visible;
      props.onHeaderMaterialVisibilityChange?.(visible);
    },
    [props.onHeaderMaterialVisibilityChange],
  );
  const handleScroll = useCallback(
    (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      // anchorTopInset, not topContentInset: under automatic insets the list
      // rests at contentOffset.y = -headerHeight (the inset lives only in
      // UIKit's adjustedContentInset, so topContentInset is 0 here). Add the
      // header height back or the material toggles a full header too late.
      reportHeaderMaterialVisibility(event.nativeEvent.contentOffset.y + anchorTopInset > 6);
      // LegendList recomputes its inset-aware end distance before invoking
      // this handler, so getState() is current. Only the actual end re-arms
      // follow: its broader maintain-scroll threshold is large enough for a
      // streaming chunk to pull a user back before their upward drag escapes.
      // A live user-scroll session still wins even if the first scroll event
      // remains inside LegendList's at-end tolerance.
      const listState = props.listRef.current?.getState();
      if (listState) {
        transitionEndFollow({
          type: "scroll",
          isAtEnd: listState.isAtEnd,
          userScrollSessionActive: userScrollSessionRef.current,
        });
      }
    },
    [reportHeaderMaterialVisibility, anchorTopInset, props.listRef, transitionEndFollow],
  );
  const clearUserScrollSettle = useCallback(() => {
    if (userScrollSettleTimerRef.current !== null) {
      clearTimeout(userScrollSettleTimerRef.current);
      userScrollSettleTimerRef.current = null;
    }
  }, []);
  const handleScrollBeginDrag = useCallback(() => {
    clearUserScrollSettle();
    userScrollSessionRef.current = true;
    // Pause before the first scroll event. Otherwise a stream update can run
    // maintainScrollAtEnd between touch-down and the drag leaving its threshold.
    transitionEndFollow({ type: "user-scroll-begin" });
  }, [clearUserScrollSettle, transitionEndFollow]);
  const finishUserScroll = useCallback(
    (releaseIsAtEnd?: boolean) => {
      clearUserScrollSettle();
      const userScrollSessionActive = userScrollSessionRef.current;
      userScrollSessionRef.current = false;
      transitionEndFollow({
        type: "user-scroll-end",
        // With no momentum, preserve the finger-release position. Streaming
        // growth during the native momentum-detection window must not turn a
        // release at the live edge into an opt-out from follow.
        isAtEnd: releaseIsAtEnd ?? props.listRef.current?.getState().isAtEnd ?? false,
        userScrollSessionActive,
      });
    },
    [clearUserScrollSettle, props.listRef, transitionEndFollow],
  );
  // Finger-lift velocity is not a reliable momentum signal: a gentle fling
  // can report zero and still decelerate. Give native momentum a short window
  // to announce itself; if it does, onMomentumScrollBegin cancels this fallback
  // and the session survives until the settled momentum-end position. This
  // mirrors the native-event handoff used by the home thread list's scroll gate.
  const handleScrollEndDrag = useCallback(() => {
    clearUserScrollSettle();
    const releaseIsAtEnd = props.listRef.current?.getState().isAtEnd ?? false;
    userScrollSettleTimerRef.current = setTimeout(() => finishUserScroll(releaseIsAtEnd), 160);
  }, [clearUserScrollSettle, finishUserScroll, props.listRef]);
  const handleMomentumScrollBegin = useCallback(() => {
    if (userScrollSessionRef.current) {
      clearUserScrollSettle();
    }
  }, [clearUserScrollSettle]);
  const handleMomentumScrollEnd = useCallback(() => {
    finishUserScroll();
  }, [finishUserScroll]);

  useEffect(() => clearUserScrollSettle, [clearUserScrollSettle]);

  const handleViewportLayout = useCallback((event: LayoutChangeEvent) => {
    const nextWidth = Math.round(event.nativeEvent.layout.width);
    const nextHeight = Math.round(event.nativeEvent.layout.height);
    setViewportWidth((current) => (Math.abs(current - nextWidth) > 1 ? nextWidth : current));
    setViewportHeight((current) => (Math.abs(current - nextHeight) > 1 ? nextHeight : current));
  }, []);

  // Thread identity is env-scoped: two environments can hold the same
  // ThreadId, and keying resets (or the list mount) on the bare id would
  // carry stale scroll/follow state across an environment switch.
  const feedThreadKey = scopedThreadKey(props.environmentId, props.threadId);

  useEffect(() => {
    reportHeaderMaterialVisibility(false);
  }, [feedThreadKey, reportHeaderMaterialVisibility]);

  // A thread switch opens pinned to the end; a send explicitly returns to the
  // live edge (ThreadDetailScreen scrolls the new message into place). Both
  // re-arm follow regardless of where the user had scrolled before.
  useEffect(() => {
    clearUserScrollSettle();
    userScrollSessionRef.current = false;
    transitionEndFollow({ type: "reset" });
  }, [clearUserScrollSettle, feedThreadKey, transitionEndFollow]);
  useEffect(() => {
    if (props.anchorMessageId !== null) {
      clearUserScrollSettle();
      userScrollSessionRef.current = false;
      transitionEndFollow({ type: "reset" });
    }
  }, [clearUserScrollSettle, props.anchorMessageId, transitionEndFollow]);

  const expandedWorkGroupIds = useMemo(() => {
    const ids = new Set<string>();
    for (const [groupId, expanded] of Object.entries(expandedWorkGroups)) {
      if (expanded) {
        ids.add(groupId);
      }
    }
    return ids;
  }, [expandedWorkGroups]);
  const presentedFeed = useMemo(
    () =>
      deriveThreadFeedPresentation(
        props.feed,
        props.latestTurn,
        expandedTurnIds,
        expandedWorkGroupIds,
        props.activeWorkStartedAt,
      ),
    [
      expandedTurnIds,
      expandedWorkGroupIds,
      props.activeWorkStartedAt,
      props.feed,
      props.latestTurn,
    ],
  );

  // The empty↔filled key below remounts the list, which resets its imperative
  // content-inset override — and useKeyboardChatComposerInset (mounted above
  // the remount boundary) deduplicates by height, so it never re-reports the
  // composer inset to the fresh instance. Without this, the remounted list's
  // initial scroll-to-end computes with a zero end inset and rests one
  // composer-height short of the end. Layout effect: it must land before the
  // list's first positioning tick or the one-shot initial scroll misses it.
  const listMountKey = `${feedThreadKey}:${props.feed.length === 0 ? "empty" : "filled"}`;
  useLayoutEffect(() => {
    const bottom = props.contentInsetEndAdjustment.value;
    if (bottom > 0) {
      props.listRef.current?.reportContentInset({ bottom });
    }
  }, [listMountKey, props.contentInsetEndAdjustment, props.listRef]);

  const anchoredEndSpace = useMemo(
    () =>
      resolveChatListAnchoredEndSpace(
        presentedFeed,
        props.anchorMessageId,
        (entry) => (entry.type === "message" ? entry.id : null),
        { anchorOffset: anchorTopInset + CHAT_LIST_ANCHOR_OFFSET },
      ),
    [presentedFeed, props.anchorMessageId, anchorTopInset],
  );
  const terminalAssistantMessageIds = useMemo(() => {
    const terminalIdsByTurn = new Map<TurnId, string>();
    for (const entry of props.feed) {
      if (entry.type === "message" && entry.message.role === "assistant" && entry.message.turnId) {
        terminalIdsByTurn.set(entry.message.turnId, entry.message.id);
      }
    }
    return new Set(terminalIdsByTurn.values());
  }, [props.feed]);
  const unsettledTurnId =
    props.latestTurn &&
    (props.latestTurn.completedAt === null || props.latestTurn.state === "running")
      ? props.latestTurn.turnId
      : null;

  useEffect(() => {
    const previous = previousLatestTurnRef.current;
    previousLatestTurnRef.current = props.latestTurn;
    if (!props.latestTurn || !previous) {
      return;
    }
    if (props.latestTurn.turnId === previous.turnId) {
      if (previous.state === "running" && props.latestTurn.state === "interrupted") {
        const interruptedTurnId = props.latestTurn.turnId;
        setInteractionState((current) => ({
          ...current,
          expandedTurnIds: new Set(current.expandedTurnIds).add(interruptedTurnId),
        }));
      }
      return;
    }
    setInteractionState((current) => {
      if (!current.expandedTurnIds.has(previous.turnId)) {
        return current;
      }
      const next = new Set(current.expandedTurnIds);
      next.delete(previous.turnId);
      return { ...current, expandedTurnIds: next };
    });
  }, [props.latestTurn]);

  useEffect(() => {
    return () => {
      if (copyFeedbackTimeoutRef.current) {
        clearTimeout(copyFeedbackTimeoutRef.current);
      }
      if (foldSettleFrameRef.current !== null) {
        cancelAnimationFrame(foldSettleFrameRef.current);
      }
      if (foldSettleSecondFrameRef.current !== null) {
        cancelAnimationFrame(foldSettleSecondFrameRef.current);
      }
    };
  }, []);

  const suspendEndScrollMaintenanceForDisclosure = useCallback((anchorKey: string | null) => {
    disclosureAnchorKeyRef.current = anchorKey;
    setDisclosureToggleSettling(true);
    if (foldSettleFrameRef.current !== null) {
      cancelAnimationFrame(foldSettleFrameRef.current);
    }
    if (foldSettleSecondFrameRef.current !== null) {
      cancelAnimationFrame(foldSettleSecondFrameRef.current);
    }
    foldSettleFrameRef.current = requestAnimationFrame(() => {
      foldSettleSecondFrameRef.current = requestAnimationFrame(() => {
        disclosureAnchorKeyRef.current = null;
        setDisclosureToggleSettling(false);
        foldSettleFrameRef.current = null;
        foldSettleSecondFrameRef.current = null;
      });
    });
  }, []);

  const shouldRestoreVisibleContentPosition = useCallback((entry: ThreadFeedEntry) => {
    const disclosureAnchorKey = disclosureAnchorKeyRef.current;
    return disclosureAnchorKey === null || entry.id === disclosureAnchorKey;
  }, []);

  const maintainVisibleContentPosition = useMemo(
    () => ({
      data: true,
      size: true,
      shouldRestorePosition: shouldRestoreVisibleContentPosition,
    }),
    [shouldRestoreVisibleContentPosition],
  );

  const onCopyWorkRow = useCallback((rowId: string, value: string) => {
    copyTextWithHaptic(value, {
      target: "thread-work-row",
      feedback: "selection",
    });
    setInteractionState((current) => ({ ...current, copiedRowId: rowId }));
    if (copyFeedbackTimeoutRef.current) {
      clearTimeout(copyFeedbackTimeoutRef.current);
    }
    copyFeedbackTimeoutRef.current = setTimeout(() => {
      setInteractionState((current) =>
        current.copiedRowId === rowId ? { ...current, copiedRowId: null } : current,
      );
      copyFeedbackTimeoutRef.current = null;
    }, 1200);
  }, []);

  const onToggleWorkGroup = useCallback(
    (groupId: string) => {
      suspendEndScrollMaintenanceForDisclosure(`work-toggle:${groupId}`);
      setInteractionState((current) => ({
        ...current,
        expandedWorkGroups: {
          ...current.expandedWorkGroups,
          [groupId]: !(current.expandedWorkGroups[groupId] ?? false),
        },
      }));
    },
    [suspendEndScrollMaintenanceForDisclosure],
  );

  const onToggleWorkRow = useCallback(
    (rowId: string) => {
      suspendEndScrollMaintenanceForDisclosure(rowId);
      setInteractionState((current) => ({
        ...current,
        expandedWorkRows: {
          ...current.expandedWorkRows,
          [rowId]: !(current.expandedWorkRows[rowId] ?? false),
        },
      }));
    },
    [suspendEndScrollMaintenanceForDisclosure],
  );

  const onToggleTurnFold = useCallback(
    (turnId: TurnId) => {
      suspendEndScrollMaintenanceForDisclosure(`turn-fold:${turnId}`);
      setInteractionState((current) => {
        const next = new Set(current.expandedTurnIds);
        if (next.has(turnId)) {
          next.delete(turnId);
        } else {
          next.add(turnId);
        }
        return { ...current, expandedTurnIds: next };
      });
    },
    [suspendEndScrollMaintenanceForDisclosure],
  );

  const onPressImage = useCallback((uri: string, headers?: Record<string, string>) => {
    setExpandedImage({ uri, headers });
  }, []);

  // Rows whose height is known before they ever render. Without this, every
  // row above the viewport is assumed to be estimatedItemSize tall, and
  // scrolling up through unmeasured content corrects each row's height as it
  // mounts — the feed visibly jumps. Fixed sizes make the small chrome rows
  // exact; message rows stay undefined and use LegendList's per-type running
  // average once one of their type has been measured. Text-driven heights
  // follow the configurable base font size via scaledTypographyLineHeight.
  const workingRowHeight =
    WORKING_ROW_VERTICAL_EXTRAS +
    scaledTypographyLineHeight(MOBILE_TYPOGRAPHY.label, appearance.baseFontSize);
  const getFixedItemSize = useCallback(
    (entry: ThreadFeedEntry) => {
      switch (entry.type) {
        case "turn-fold":
          return TURN_FOLD_HEIGHT;
        case "work-toggle":
          return WORK_GROUP_TOGGLE_HEIGHT;
        case "working":
          return workingRowHeight;
        case "activity-group":
          // Expanded rows append a variable detail block — fall back to
          // measurement for those groups.
          return entry.activities.some((activity) => expandedWorkRows[activity.id])
            ? undefined
            : collapsedWorkLogHeight(entry.activities, appearance.baseFontSize);
        default:
          return undefined;
      }
    },
    [expandedWorkRows, workingRowHeight, appearance.baseFontSize],
  );

  const renderItem = useCallback(
    (info: { item: ThreadFeedEntry; index: number }) =>
      renderFeedEntry(info, {
        environmentId: props.environmentId,
        copiedRowId,
        expandedWorkRows,
        terminalAssistantMessageIds,
        unsettledTurnId,
        onCopyWorkRow,
        onToggleWorkGroup,
        onToggleWorkRow,
        onToggleTurnFold,
        onPressImage,
        onMarkdownLinkPress,
        iconSubtleColor,
        userBubbleColor,
        markdownStyles,
        reviewCommentColors,
        reviewCommentBubbleWidth,
        userBubbleMaxWidth,
        skills: props.skills,
      }),
    [
      copiedRowId,
      expandedWorkRows,
      terminalAssistantMessageIds,
      unsettledTurnId,
      iconSubtleColor,
      userBubbleColor,
      markdownStyles,
      reviewCommentColors,
      reviewCommentBubbleWidth,
      userBubbleMaxWidth,
      onCopyWorkRow,
      onMarkdownLinkPress,
      onPressImage,
      onToggleTurnFold,
      onToggleWorkGroup,
      onToggleWorkRow,
      props.environmentId,
      props.skills,
    ],
  );

  if (props.contentPresentation.kind === "unavailable") {
    return (
      <ThreadFeedPlaceholder
        title={props.contentPresentation.title}
        detail={props.contentPresentation.detail}
        topInset={topContentInset}
        bottomInset={bottomContentInset}
        horizontalPadding={horizontalPadding}
      />
    );
  }

  return (
    <>
      <View className="flex-1" onLayout={handleViewportLayout}>
        <View className="flex-1">
          <KeyboardAwareLegendList
            ref={props.listRef}
            // The empty↔filled key remounts the list when messages first
            // arrive. LegendList's maintainScrollAtEnd calls scrollToEnd(),
            // which is blind to UIKit's adjustedContentInset — inserting into
            // an already-attached list under a transparent header can pin
            // short content at offset 0 (one header-height too high). A fresh
            // mount positions during attach, where UIKit applies the inset.
            key={listMountKey}
            style={{ flex: 1 }}
            // RN 0.81+ drops touches inside the contentInset area
            // (facebook/react-native#54123); the anchored end space after a send
            // is pure inset, so without this the blank region can't be scrolled.
            applyWorkaroundForContentInsetHitTestBug
            contentInsetAdjustmentBehavior={usesNativeAutomaticInsets ? "automatic" : "never"}
            automaticallyAdjustsScrollIndicatorInsets={usesNativeAutomaticInsets}
            {...(usesNativeAutomaticInsets
              ? {
                  // Do NOT pass a manual `contentInset` here. Like the Home
                  // ScrollView, we rely purely on `contentInsetAdjustmentBehavior:
                  // "automatic"` so UIKit derives the top inset from the transparent
                  // header. A manual contentInset (which LegendList consumes into its
                  // own layout math) collapses the scroll view's adjustedContentInset
                  // top to 0, leaving the iOS 26/27 scroll-edge effect no region to
                  // render into — which is why the header blur was missing on threads.
                  scrollIndicatorInsets: { top: 0, left: 0, right: 0, bottom: 0 },
                }
              : { scrollIndicatorInsets: { top: topContentInset, bottom: 0 } })}
            {...(anchoredEndSpace ? { anchoredEndSpace } : {})}
            // Patched LegendList prop (patches/@legendapp__list@3.2.0.patch):
            // lets its scroll math clamp programmatic scrolls to -headerInset
            // instead of 0, so initialScrollAtEnd/maintainScrollAtEnd on short
            // content rest below the transparent header rather than at frame top.
            contentInsetStartAdjustment={usesNativeAutomaticInsets ? anchorTopInset : 0}
            contentInsetEndAdjustment={props.contentInsetEndAdjustment}
            // UIKit's automatic behavior adds the safe-area bottom on top of the
            // raw contentInset the keyboard integration writes. The detail screen
            // under-reports the composer inset by this amount (see
            // ThreadDetailScreen); this tells LegendList's scroll math about the
            // extra so programmatic end scrolls land at the true resting offset.
            contentInsetEndStaticAdjustment={usesNativeAutomaticInsets ? insets.bottom : 0}
            // The keyboard integration's offset math (end pinning, max scroll)
            // must add the same UIKit-added extra, or its keyboard-open end
            // targets land one safe-area short of the true resting offset.
            adjustedInsetCompensation={usesNativeAutomaticInsets ? insets.bottom : 0}
            freeze={props.freeze}
            // Animated: on send, the optimistic message's dataChange fires
            // maintainScrollAtEnd before any render-cycle suppression could
            // engage — an instant snap there teleports the feed to the anchor
            // instead of scrolling to it. Keeping it enabled (animated) during
            // anchor scrolls also lets it correct a scroll that landed on a
            // stale end target once the anchor row finishes measuring.
            maintainScrollAtEnd={
              disclosureToggleSettling || !endFollowEnabled
                ? false
                : {
                    animated: true,
                    on: {
                      dataChange: true,
                      itemLayout: true,
                      layout: true,
                    },
                  }
            }
            maintainVisibleContentPosition={maintainVisibleContentPosition}
            data={presentedFeed}
            extraData={listAppearanceData}
            renderItem={renderItem}
            keyExtractor={(entry) => entry.id}
            getItemType={(entry) =>
              entry.type === "message" ? `message:${entry.message.role}` : entry.type
            }
            getFixedItemSize={getFixedItemSize}
            // Measure rows well before they scroll into view so estimate→actual
            // corrections land offscreen instead of under the user's finger.
            drawDistance={500}
            keyboardShouldPersistTaps="always"
            keyboardDismissMode="none"
            keyboardLiftBehavior="whenAtEnd"
            // Seed the list's scroll math with the real viewport before its own
            // onLayout: the empty→filled remount can then tell at mount that
            // short content underflows the viewport and skip programmatic
            // positioning entirely (any offset write during screen attach races
            // UIKit's adjustedContentInset application and lands high or low).
            {...(viewportHeight > 0 && viewportWidth > 0
              ? { estimatedListSize: { height: viewportHeight, width: viewportWidth } }
              : {})}
            // RN's native scrollTo command clamps targets to a floor of
            // -contentInset.top using the RAW inset — under automatic insets the
            // header inset only exists in adjustedContentInset, so scrolls to
            // negative offsets (content top below the transparent header) get
            // clamped to 0. This prop disables that clamp; UIKit still bounces
            // user overscroll back to the adjusted rest position.
            scrollToOverflowEnabled
            estimatedItemSize={180}
            // Chat-style bottom alignment: when a thread is shorter than the
            // viewport, pad above the content so messages rest just above the
            // composer instead of under the header. No effect on threads that
            // overflow the viewport (the padding clamps to zero).
            alignItemsAtEnd
            initialScrollAtEnd
            onScroll={handleScroll}
            onScrollBeginDrag={handleScrollBeginDrag}
            onScrollEndDrag={handleScrollEndDrag}
            onMomentumScrollBegin={handleMomentumScrollBegin}
            onMomentumScrollEnd={handleMomentumScrollEnd}
            scrollEventThrottle={16}
            ListHeaderComponent={
              <>
                {usesNativeAutomaticInsets ? null : <View style={{ height: topContentInset }} />}
                {props.loadEarlier != null ? (
                  <Pressable
                    onPress={props.loadEarlier.onLoadEarlier}
                    disabled={props.loadEarlier.loading}
                    className="items-center py-2"
                  >
                    <Text className="text-xs text-foreground-secondary">
                      {props.loadEarlier.loading ? "Loading earlier turns…" : "Load earlier turns"}
                    </Text>
                  </Pressable>
                ) : null}
              </>
            }
            contentContainerStyle={{
              paddingTop: 12,
              paddingHorizontal: contentHorizontalPadding,
            }}
          />
        </View>
        {props.feed.length === 0 &&
        props.activeWorkStartedAt === null &&
        props.contentPresentation.kind === "ready" ? (
          <View pointerEvents="none" style={StyleSheet.absoluteFill}>
            <ThreadFeedPlaceholder
              title="No conversation yet"
              detail="Ask the agent to inspect the repo, run a command, or continue the active thread."
              topInset={topContentInset}
              bottomInset={bottomContentInset}
              horizontalPadding={horizontalPadding}
            />
          </View>
        ) : null}
      </View>

      <ImageViewing
        images={
          expandedImage
            ? [
                {
                  uri: expandedImage.uri,
                  headers: expandedImage.headers,
                },
              ]
            : []
        }
        imageIndex={0}
        visible={expandedImage !== null}
        onRequestClose={() => setExpandedImage(null)}
        swipeToCloseEnabled
        doubleTapToZoomEnabled
      />
    </>
  );
});

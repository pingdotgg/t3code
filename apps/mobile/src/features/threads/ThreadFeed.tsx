import * as Haptics from "expo-haptics";
import { KeyboardAwareLegendList } from "@legendapp/list/keyboard";
import { type LegendListRef } from "@legendapp/list/react-native";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { canForkProjectedAssistantItem } from "@t3tools/client-runtime/state/thread-workflows";
import {
  ThreadId,
  type EnvironmentId,
  type MessageId,
  type OrchestrationV2ProjectedTurnItem,
  type RunId,
} from "@t3tools/contracts";
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
  Alert,
  Image,
  Linking,
  Platform,
  type LayoutChangeEvent,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  Pressable,
  ScrollView,
  StyleSheet,
  Text as NativeText,
  type ColorValue,
  useColorScheme,
  useWindowDimensions,
  View,
} from "react-native";
import { TouchableOpacity } from "react-native-gesture-handler";
import ImageViewing from "react-native-image-viewing";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import Animated, {
  FadeIn,
  FadeInUp,
  useSharedValue,
  withTiming,
  type LayoutAnimationsValues,
  type SharedValue,
} from "react-native-reanimated";
import { useThemeColor } from "../../lib/useThemeColor";
import { useFontFamily } from "../../lib/useFontFamily";
import { copyTextWithHaptic } from "../../lib/copyTextWithHaptic";
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
import type { LayoutVariant } from "../../lib/layout";
import { buildThreadFilesNavigation } from "../../lib/routes";
import { buildThreadRoutePath } from "../../lib/routes";
import { uuidv4 } from "../../lib/uuid";
import { MOBILE_CODE_SURFACE, MOBILE_TYPOGRAPHY } from "../../lib/typography";
import { markdownFileIconSource } from "@t3tools/mobile-markdown-text/file-icons";
import { resolveMarkdownLinkPresentation } from "@t3tools/mobile-markdown-text/links";
import {
  deriveThreadFeedPresentation,
  threadFeedRunIsUnsettled,
  type ThreadFeedEntry,
  type ThreadFeedLatestRun,
} from "../../lib/threadActivity";
import type { ThreadContentPresentation } from "./threadContentPresentation";
import {
  collapsedWorkLogHeight,
  ThreadWorkGroupToggle,
  ThreadWorkLog,
  WORK_GROUP_TOGGLE_HEIGHT,
} from "./thread-work-log";
import { useMarkdownCodeHighlight } from "./markdownCodeHighlightState";
import { useAssetUrl } from "../../state/assets";
import { appAtomRegistry } from "../../state/atom-registry";
import { environmentThreadShells, threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { useV2ItemSupport } from "../../state/v2-item-support";
import { resolveWorkspaceRelativeFilePath } from "../files/filePath";
import { waitForThreadShellReady } from "./threadForkNavigation";
import { resolveUserMessageIntentBadge } from "./userMessageIntentBadge";

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

// Rows shift when content above them grows (streaming text, work-log folds);
// animating the container position turns those jumps into slides. Applied
// conditionally — see the gated transition in ThreadFeed: while browsing
// history the animation must NOT run, or every estimate→actual size
// correction plays as a visible slide against the instant scroll-offset
// compensation from maintainVisibleContentPosition.
const FEED_ITEM_LAYOUT_DURATION_MS = 180;

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
  readonly threadTitle: string;
  readonly workspaceRoot?: string | null;
  readonly feed: ReadonlyArray<ThreadFeedEntry>;
  readonly contentPresentation: ThreadContentPresentation;
  readonly agentLabel: string;
  readonly latestRun: ThreadFeedLatestRun | null;
  readonly listRef: RefObject<LegendListRef | null>;
  readonly freeze: SharedValue<boolean>;
  readonly anchorMessageId: MessageId | null;
  readonly contentInsetEndAdjustment: SharedValue<number>;
  readonly contentTopInset?: number;
  readonly contentBottomInset?: number;
  readonly topAccessory?: ReactNode;
  readonly layoutVariant?: LayoutVariant;
  readonly usesAutomaticContentInsets?: boolean;
  readonly onHeaderMaterialVisibilityChange?: (visible: boolean) => void;
  readonly skills?: ReadonlyArray<SelectableMarkdownSkill>;
}

async function waitForThreadShell(
  environmentId: EnvironmentId,
  threadId: ThreadId,
): Promise<boolean> {
  const atom = environmentThreadShells.threadShellAtom(scopeThreadRef(environmentId, threadId));
  return waitForThreadShellReady({
    read: () => appAtomRegistry.get(atom) !== null,
  });
}

function AssistantForkButton(props: {
  readonly environmentId: EnvironmentId;
  readonly iconColor: ColorValue;
  readonly projectedItem: OrchestrationV2ProjectedTurnItem;
  readonly sourceTitle: string;
}) {
  const support = useV2ItemSupport({
    environmentId: props.environmentId,
    sourceThreadId: props.projectedItem.sourceThreadId,
    sourceItemId: props.projectedItem.sourceItemId,
  });
  const forkFromRun = useAtomCommand(threadEnvironment.forkFromRun, "fork from response");
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const canFork = canForkProjectedAssistantItem({
    projectedItem: props.projectedItem,
    capabilities: support.providerSession?.capabilities,
  });
  const runId = props.projectedItem.item.runId;

  if (!canFork || runId === null) return null;

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="Fork from this response"
      disabled={busy}
      onPress={() => {
        const targetThreadId = ThreadId.make(uuidv4());
        setBusy(true);
        void Haptics.selectionAsync();
        void forkFromRun({
          environmentId: props.environmentId,
          input: {
            sourceThreadId: props.projectedItem.sourceThreadId,
            targetThreadId,
            runId,
            title: `${props.sourceTitle} fork`,
            creationSource: "mobile",
          },
        })
          .then(async (result) => {
            if (result._tag !== "Success") return;
            const targetThreadReady = await waitForThreadShell(props.environmentId, targetThreadId);
            if (!targetThreadReady) {
              Alert.alert(
                "Fork created",
                "Its thread data did not reach this client. Reconnect and try opening it from the thread list.",
              );
              return;
            }
            navigation.navigate("Thread", {
              environmentId: props.environmentId,
              threadId: targetThreadId,
            });
          })
          .finally(() => setBusy(false));
      }}
      className="h-7 w-7 items-center justify-center disabled:opacity-40"
    >
      {busy ? (
        <ActivityIndicator size="small" />
      ) : (
        <SymbolView
          name="arrow.triangle.branch"
          size={13}
          tintColor={props.iconColor}
          type="monochrome"
        />
      )}
    </Pressable>
  );
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

const MARKDOWN_COLORS = {
  light: {
    body: "#111111",
    strong: "#000000",
    link: "#2563eb",
    blockquoteBorder: "rgba(0, 0, 0, 0.08)",
    blockquoteBackground: "rgba(0, 0, 0, 0.02)",
    codeBackground: "rgba(0, 0, 0, 0.04)",
    codeText: "#262626",
    inlineCodeText: "#5f6368",
    horizontalRule: "rgba(0, 0, 0, 0.08)",
    userBody: "#ffffff",
    userCodeBackground: "rgba(255, 255, 255, 0.22)",
    userCodeText: "#ffffff",
    userInlineCodeText: "rgba(255, 255, 255, 0.82)",
    userFenceBackground: "rgba(0, 0, 0, 0.16)",
    userFenceText: "#ffffff",
  },
  dark: {
    body: "#e5e5e5",
    strong: "#f5f5f5",
    link: "#60a5fa",
    blockquoteBorder: "rgba(255, 255, 255, 0.1)",
    blockquoteBackground: "rgba(255, 255, 255, 0.03)",
    codeBackground: "rgba(255, 255, 255, 0.06)",
    codeText: "#e5e5e5",
    inlineCodeText: "#b8bcc2",
    horizontalRule: "rgba(255, 255, 255, 0.08)",
    userBody: "#ffffff",
    userCodeBackground: "rgba(255, 255, 255, 0.18)",
    userCodeText: "#ffffff",
    userInlineCodeText: "rgba(255, 255, 255, 0.82)",
    userFenceBackground: "rgba(0, 0, 0, 0.28)",
    userFenceText: "#ffffff",
  },
} as const;

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
        void Linking.openURL(props.href);
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
  const colorScheme = useColorScheme();
  const isDark = colorScheme === "dark";
  const background = isDark ? "#151515" : "#ffffff";
  const border = isDark ? "#2a2a2a" : "#d7d7d7";
  const mutedBackground = isDark ? "#242424" : "#f2f2f2";
  const text = isDark ? "#f3f3f3" : "#111111";
  const mutedText = isDark ? "#8f8f8f" : "#666666";
  const codeBackground = isDark ? "#0f0f0f" : "#ffffff";

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
  const colorScheme = useColorScheme();
  const { appearance } = useAppearancePreferences();
  const markdownFontSizes = useMemo(
    () => resolveMarkdownFontSizes(appearance.baseFontSize),
    [appearance.baseFontSize],
  );
  const nativeMarkdownTypography = useMemo(
    () => resolveNativeMarkdownTypography(appearance.baseFontSize),
    [appearance.baseFontSize],
  );
  const themeMode = colorScheme === "dark" ? "dark" : "light";
  const colors = MARKDOWN_COLORS[themeMode];
  const iconSubtleColor = String(useThemeColor("--color-icon-subtle"));
  const inlineSkillForeground = String(useThemeColor("--color-inline-skill-foreground"));
  const userBubbleForegroundMuted = String(useThemeColor("--color-user-bubble-foreground-muted"));
  const regularFontFamily = useFontFamily("regular");
  const boldFontFamily = useFontFamily("bold");

  return useMemo(() => {
    const markdownBodyColor = colors.body;
    const markdownStrongColor = colors.strong;
    const markdownLinkColor = colors.link;
    const markdownBlockquoteBg = colors.blockquoteBackground;
    const markdownBlockquoteBorder = colors.blockquoteBorder;
    const markdownCodeBg = colors.codeBackground;
    const markdownCodeText = colors.codeText;
    const markdownInlineCodeText = colors.inlineCodeText;
    const markdownHrColor = colors.horizontalRule;
    const markdownUserBodyColor = colors.userBody;
    const markdownUserCodeBg = colors.userCodeBackground;
    const markdownUserCodeText = colors.userCodeText;
    const markdownUserInlineCodeText = colors.userInlineCodeText;
    const markdownUserFenceBg = colors.userFenceBackground;
    const markdownUserFenceText = colors.userFenceText;

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
                    void Linking.openURL(linkHref);
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
          fileTextColor: "#ffffff",
          skillTextColor: "#f0abfc",
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
    colors,
    iconSubtleColor,
    inlineSkillForeground,
    markdownFontSizes,
    nativeMarkdownTypography,
    onLinkPress,
    regularFontFamily,
    themeMode,
    userBubbleForegroundMuted,
  ]);
}

function renderFeedEntry(
  info: { item: ThreadFeedEntry; index: number },
  props: Pick<ThreadFeedProps, "environmentId" | "skills" | "threadId" | "workspaceRoot"> & {
    readonly copiedRowId: string | null;
    readonly expandedWorkRows: Record<string, boolean>;
    readonly terminalAssistantMessageIds: ReadonlySet<string>;
    readonly unsettledTurnId: RunId | null;
    readonly onCopyWorkRow: (rowId: string, value: string) => void;
    readonly onToggleWorkGroup: (groupId: string) => void;
    readonly onToggleWorkRow: (rowId: string) => void;
    readonly onToggleTurnFold: (runId: RunId) => void;
    readonly onPressImage: (uri: string, headers?: Record<string, string>) => void;
    readonly onMarkdownLinkPress: (href: string) => void;
    readonly iconSubtleColor: string | import("react-native").ColorValue;
    readonly userBubbleColor: string | import("react-native").ColorValue;
    readonly markdownStyles: MarkdownStyleSets;
    readonly reviewCommentColors: ReviewCommentColors;
    readonly reviewCommentBubbleWidth: number;
    readonly userBubbleMaxWidth: number;
    readonly threadTitle: string;
  },
) {
  const entry = info.item;
  const { markdownStyles, iconSubtleColor, userBubbleColor } = props;

  if (entry.type === "run-fold") {
    return (
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: entry.expanded }}
        onPress={() => props.onToggleTurnFold(entry.runId)}
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
    const assistantTurnStillInProgress =
      message.role === "assistant" &&
      props.unsettledTurnId !== null &&
      message.runId === props.unsettledTurnId;
    const showAssistantMeta =
      message.role === "assistant" &&
      props.terminalAssistantMessageIds.has(message.id) &&
      !assistantTurnStillInProgress &&
      !message.streaming;

    if (isUser) {
      const enterAnimated = isFreshTimestamp(message.createdAt);
      const intentBadge = resolveUserMessageIntentBadge(message.inputIntent);
      return (
        <View className="mb-5 items-end">
          {message.createdBy === "agent" ? (
            <Text className="mb-1 pr-1 font-t3-medium text-2xs text-foreground-muted opacity-60">
              Sent by another agent
            </Text>
          ) : null}
          <View
            className="min-w-0 gap-2 rounded-[20px] px-3.5 py-2.5"
            style={{
              backgroundColor: userBubbleColor,
              maxWidth: props.userBubbleMaxWidth,
              ...(hasReviewCommentContext ? { width: props.reviewCommentBubbleWidth } : null),
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
            {intentBadge ? (
              <View
                accessible
                accessibilityRole="text"
                accessibilityLabel={intentBadge.accessibilityLabel}
                className={cn(
                  "rounded-full border px-1.5 py-0.5",
                  intentBadge.tone === "queued"
                    ? "border-amber-500/25 bg-amber-500/10 dark:border-amber-400/25 dark:bg-amber-400/10"
                    : "border-sky-500/25 bg-sky-500/10 dark:border-sky-400/25 dark:bg-sky-400/10",
                )}
              >
                <Text
                  className={cn(
                    "font-t3-medium text-2xs tracking-wide",
                    intentBadge.tone === "queued"
                      ? "text-amber-700 dark:text-amber-300"
                      : "text-sky-700 dark:text-sky-300",
                  )}
                >
                  {intentBadge.label}
                </Text>
              </View>
            ) : null}
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
            <AssistantForkButton
              environmentId={props.environmentId}
              iconColor={iconSubtleColor}
              projectedItem={message.projectedItem}
              sourceTitle={props.threadTitle}
            />
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
      currentThreadId={props.threadId}
      environmentId={props.environmentId}
      expanded={props.expandedWorkGroups[entry.id] ?? false}
      expandedRows={props.expandedWorkRows}
      iconSubtleColor={iconSubtleColor}
      onCopyRow={props.onCopyWorkRow}
      onToggleRow={props.onToggleWorkRow}
      workspaceRoot={props.workspaceRoot}
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
  const colorScheme = useColorScheme();
  const appearanceScheme = colorScheme === "light" ? "light" : "dark";
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
    () => createNativeReviewDiffTheme(appearanceScheme),
    [appearanceScheme],
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
  const previousLatestTurnRef = useRef(props.latestRun);
  const { width: viewportWidth } = useWindowDimensions();
  const [foldToggleSettling, setFoldToggleSettling] = useState(false);
  const [interactionState, setInteractionState] = useState<{
    readonly copiedRowId: string | null;
    readonly expandedWorkGroups: Record<string, boolean>;
    readonly expandedWorkRows: Record<string, boolean>;
    readonly expandedTurnIds: ReadonlySet<RunId>;
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
  const topContentInset = props.contentTopInset ?? insets.top + 44;
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
    ? navigationHeaderHeight || insets.top + 44
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
        void Linking.openURL(presentation.href);
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
  const presentedFeed = useMemo(
    () => deriveThreadFeedPresentation(props.feed, props.latestRun, expandedTurnIds),
    [expandedTurnIds, props.feed, props.latestRun],
  );
  // True while the viewport sits within ~one screen of the list end — the
  // only region where layout shifts should animate. Starts true because the
  // list opens pinned to the end.
  const nearListEnd = useSharedValue(true);

  const handleScroll = useCallback(
    (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      // anchorTopInset, not topContentInset: under automatic insets the list
      // rests at contentOffset.y = -headerHeight (the inset lives only in
      // UIKit's adjustedContentInset, so topContentInset is 0 here). Add the
      // header height back or the material toggles a full header too late.
      reportHeaderMaterialVisibility(event.nativeEvent.contentOffset.y + anchorTopInset > 6);
      const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent;
      nearListEnd.value =
        contentSize.height - layoutMeasurement.height - contentOffset.y < layoutMeasurement.height;
    },
    [reportHeaderMaterialVisibility, anchorTopInset, nearListEnd],
  );

  // Gated variant of the 180ms feed layout slide. Instant while browsing
  // history: maintainVisibleContentPosition compensates the scroll offset in
  // the same frame a row's measured size lands, so an instant reposition is
  // invisible — animating it is exactly what made cold upward scrolls slide
  // and jump. Near the end the slide stays on: streaming growth and sends
  // shift rows at rest, where the animation is the thing preventing a hard
  // visual snap.
  const feedItemLayoutTransition = useMemo(() => {
    return (values: LayoutAnimationsValues) => {
      "worklet";
      const duration = nearListEnd.value ? FEED_ITEM_LAYOUT_DURATION_MS : 0;
      return {
        initialValues: {
          originX: values.currentOriginX,
          originY: values.currentOriginY,
          width: values.currentWidth,
          height: values.currentHeight,
        },
        animations: {
          originX: withTiming(values.targetOriginX, { duration }),
          originY: withTiming(values.targetOriginY, { duration }),
          width: withTiming(values.targetWidth, { duration }),
          height: withTiming(values.targetHeight, { duration }),
        },
      };
    };
  }, [nearListEnd]);
  const handleViewportLayout = useCallback((event: LayoutChangeEvent) => {
    const nextWidth = Math.round(event.nativeEvent.layout.width);
    const nextHeight = Math.round(event.nativeEvent.layout.height);
    setViewportWidth((current) => (Math.abs(current - nextWidth) > 1 ? nextWidth : current));
    setViewportHeight((current) => (Math.abs(current - nextHeight) > 1 ? nextHeight : current));
  }, []);

  useEffect(() => {
    reportHeaderMaterialVisibility(false);
  }, [props.threadId, reportHeaderMaterialVisibility]);

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
  const listMountKey = `${props.threadId}:${props.feed.length === 0 ? "empty" : "filled"}`;
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
    const terminalIdsByTurn = new Map<RunId, string>();
    for (const entry of props.feed) {
      if (entry.type === "message" && entry.message.role === "assistant" && entry.message.runId) {
        terminalIdsByTurn.set(entry.message.runId, entry.message.id);
      }
    }
    return new Set(terminalIdsByTurn.values());
  }, [props.feed]);
  const unsettledTurnId = threadFeedRunIsUnsettled(props.latestRun) ? props.latestRun.runId : null;

  useEffect(() => {
    const previous = previousLatestTurnRef.current;
    previousLatestTurnRef.current = props.latestRun;
    if (!props.latestRun || !previous) {
      return;
    }
    if (props.latestRun.runId === previous.runId) {
      if (previous.status === "running" && props.latestRun.status === "interrupted") {
        const interruptedTurnId = props.latestRun.runId;
        setInteractionState((current) => ({
          ...current,
          expandedTurnIds: new Set(current.expandedTurnIds).add(interruptedTurnId),
        }));
      }
      return;
    }
    setInteractionState((current) => {
      if (!current.expandedTurnIds.has(previous.runId)) {
        return current;
      }
      const next = new Set(current.expandedTurnIds);
      next.delete(previous.runId);
      return { ...current, expandedTurnIds: next };
    });
  }, [props.latestRun]);

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

  const onToggleTurnFold = useCallback((runId: RunId) => {
    setFoldToggleSettling(true);
    if (foldSettleFrameRef.current !== null) {
      cancelAnimationFrame(foldSettleFrameRef.current);
    }
    if (foldSettleSecondFrameRef.current !== null) {
      cancelAnimationFrame(foldSettleSecondFrameRef.current);
    }
    setInteractionState((current) => {
      const next = new Set(current.expandedTurnIds);
      if (next.has(runId)) {
        next.delete(runId);
      } else {
        next.add(runId);
      }
      return { ...current, expandedTurnIds: next };
    });
    foldSettleFrameRef.current = requestAnimationFrame(() => {
      foldSettleSecondFrameRef.current = requestAnimationFrame(() => {
        setFoldToggleSettling(false);
        foldSettleFrameRef.current = null;
        foldSettleSecondFrameRef.current = null;
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
        threadId: props.threadId,
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
        threadTitle: props.threadTitle,
        skills: props.skills,
        workspaceRoot: props.workspaceRoot,
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
      props.threadId,
      props.threadTitle,
      props.skills,
      props.workspaceRoot,
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
          }
          maintainVisibleContentPosition
          data={presentedFeed}
          extraData={listAppearanceData}
          renderItem={renderItem}
          keyExtractor={(entry) => entry.id}
          getItemType={(entry) =>
            entry.type === "message" ? `message:${entry.message.role}` : entry.type
          }
          keyboardShouldPersistTaps="always"
          keyboardDismissMode="none"
          keyboardLiftBehavior="whenAtEnd"
          estimatedItemSize={180}
          initialScrollAtEnd
          ListHeaderComponent={
            <>
              <View style={{ height: topContentInset }} />
              {props.topAccessory}
            </>
          }
          contentContainerStyle={{
            paddingTop: 12,
            paddingHorizontal: horizontalPadding,
          }}
        />
        {props.feed.length === 0 ? (
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

import * as Clipboard from "expo-clipboard";
import * as Haptics from "expo-haptics";
import { KeyboardAvoidingLegendList } from "@legendapp/list/keyboard";
import { type LegendListRef } from "@legendapp/list/react-native";
import type { ThreadId } from "@t3tools/contracts";
import { SymbolView } from "expo-symbols";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Markdown,
  type CustomRenderers,
  type NodeStyleOverrides,
  type PartialMarkdownTheme,
} from "react-native-nitro-markdown";
import {
  Image,
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
import { useThemeColor } from "../../lib/useThemeColor";

import { AppText as Text } from "../../components/AppText";
import { EmptyState } from "../../components/EmptyState";
import {
  parseReviewCommentMessageSegments,
  type ReviewInlineComment,
} from "../review/reviewCommentSelection";
import { resolveNativeReviewDiffView } from "../diffs/nativeReviewDiffSurface";
import {
  buildNativeReviewDiffData,
  createNativeReviewDiffTheme,
  NATIVE_REVIEW_DIFF_CONTENT_WIDTH,
  NATIVE_REVIEW_DIFF_ROW_HEIGHT,
  NATIVE_REVIEW_DIFF_STYLE,
} from "../review/nativeReviewDiffAdapter";
import { buildReviewParsedDiff } from "../review/reviewModel";
import { cn } from "../../lib/cn";
import type { MobileLayoutVariant } from "../../lib/mobileLayout";
import type { ThreadFeedEntry } from "../../lib/threadActivity";
import { relativeTime } from "../../lib/time";
import { messageImageUrl } from "./threadPresentation";

export interface ThreadFeedProps {
  readonly threadId: ThreadId;
  readonly feed: ReadonlyArray<ThreadFeedEntry>;
  readonly httpBaseUrl: string | null;
  readonly bearerToken: string | null;
  readonly agentLabel: string;
  readonly contentBottomInset?: number;
  readonly refreshing?: boolean;
  readonly onRefresh?: () => void;
  readonly layoutVariant?: MobileLayoutVariant;
  readonly composerExpanded?: boolean;
}

function stripShellWrapper(value: string): string {
  const trimmed = value.trim();
  const match = trimmed.match(/^\/bin\/zsh -lc ['"]?([\s\S]*?)['"]?$/);
  return (match?.[1] ?? trimmed).trim();
}

function compactActivityDetail(detail: string | null): string | null {
  if (!detail) {
    return null;
  }

  const cleaned = stripShellWrapper(detail).replace(/\s+/g, " ").trim();
  return cleaned.length > 0 ? cleaned : null;
}

function buildActivityRows(
  activities: ReadonlyArray<{
    readonly id: string;
    readonly createdAt: string;
    readonly summary: string;
    readonly detail: string | null;
    readonly status: string | null;
  }>,
) {
  return activities.map<{
    id: string;
    createdAt: string;
    summary: string;
    detail: string | null;
    status: string | null;
  }>((activity) => ({
    id: activity.id,
    createdAt: activity.createdAt,
    summary: activity.summary,
    detail: compactActivityDetail(activity.detail),
    status: activity.status,
  }));
}

const MAX_VISIBLE_WORK_LOG_ENTRIES = 6;

function toMarkdownThemeColor(value: ColorValue): string {
  return value as string;
}

interface MarkdownStyleSets {
  readonly user: MarkdownStyleSet;
  readonly assistant: MarkdownStyleSet;
}

interface MarkdownStyleSet {
  readonly theme: PartialMarkdownTheme;
  readonly styles: NodeStyleOverrides;
  readonly renderers: CustomRenderers;
}

interface ReviewCommentColors {
  readonly background: ColorValue;
  readonly border: ColorValue;
  readonly mutedBackground: ColorValue;
  readonly text: ColorValue;
  readonly mutedText: ColorValue;
  readonly codeBackground: ColorValue;
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

function useMarkdownStyles(): MarkdownStyleSets {
  const bodyColor = useThemeColor("--color-md-body");
  const strongColor = useThemeColor("--color-md-strong");
  const linkColor = useThemeColor("--color-md-link");
  const blockquoteBg = useThemeColor("--color-md-blockquote-bg");
  const blockquoteBorder = useThemeColor("--color-md-blockquote-border");
  const codeBg = useThemeColor("--color-md-code-bg");
  const codeText = useThemeColor("--color-md-code-text");
  const hrColor = useThemeColor("--color-md-hr");
  const userBodyColor = useThemeColor("--color-user-bubble-foreground");
  const userCodeBg = useThemeColor("--color-md-user-code-bg");
  const userCodeText = useThemeColor("--color-md-user-code-text");
  const userFenceBg = useThemeColor("--color-md-user-fence-bg");
  const userFenceText = useThemeColor("--color-md-user-fence-text");

  return useMemo(() => {
    const markdownBodyColor = toMarkdownThemeColor(bodyColor);
    const markdownStrongColor = toMarkdownThemeColor(strongColor);
    const markdownLinkColor = toMarkdownThemeColor(linkColor);
    const markdownBlockquoteBg = toMarkdownThemeColor(blockquoteBg);
    const markdownBlockquoteBorder = toMarkdownThemeColor(blockquoteBorder);
    const markdownCodeBg = toMarkdownThemeColor(codeBg);
    const markdownCodeText = toMarkdownThemeColor(codeText);
    const markdownHrColor = toMarkdownThemeColor(hrColor);
    const markdownUserBodyColor = toMarkdownThemeColor(userBodyColor);
    const markdownUserCodeBg = toMarkdownThemeColor(userCodeBg);
    const markdownUserCodeText = toMarkdownThemeColor(userCodeText);
    const markdownUserFenceBg = toMarkdownThemeColor(userFenceBg);
    const markdownUserFenceText = toMarkdownThemeColor(userFenceText);

    const baseTheme: PartialMarkdownTheme = {
      colors: {
        text: markdownBodyColor,
        heading: markdownStrongColor,
        link: markdownLinkColor,
        blockquote: markdownBlockquoteBorder,
        border: markdownHrColor,
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
        s: 13,
        m: 15,
        h1: 22,
        h2: 19,
        h3: 17,
        h4: 15,
        h5: 15,
        h6: 15,
      },
      fontFamilies: {
        regular: "DMSans_400Regular",
        heading: "DMSans_700Bold",
        mono: "ui-monospace",
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
      paragraph: { marginTop: 0, marginBottom: 8 },
      list: { marginTop: 4, marginBottom: 4 },
      list_item: { marginTop: 0, marginBottom: 4 },
      task_list_item: { marginTop: 0, marginBottom: 4 },
      text: { lineHeight: 22 },
      bold: {
        fontWeight: "700",
        color: markdownStrongColor,
        fontFamily: "DMSans_700Bold",
      },
      italic: { fontStyle: "italic" },
      link: {
        color: markdownLinkColor,
        textDecorationLine: "underline" as const,
      },
      blockquote: {
        borderLeftWidth: 3,
        borderLeftColor: markdownBlockquoteBorder,
        backgroundColor: markdownBlockquoteBg,
        paddingLeft: 12,
        paddingVertical: 6,
        marginLeft: 0,
        marginVertical: 4,
        borderRadius: 4,
      },
      heading: {
        fontFamily: "DMSans_700Bold",
        color: markdownStrongColor,
        marginTop: 12,
        marginBottom: 6,
      },
      horizontal_rule: {
        backgroundColor: markdownHrColor,
        height: 1,
        marginVertical: 12,
      },
    };

    const createCodeRenderers = (
      inlineBackgroundColor: string,
      inlineTextColor: string,
      blockBackgroundColor: string,
      blockTextColor: string,
    ): CustomRenderers => ({
      code_inline: ({ content }) => (
        <NativeText
          style={{
            backgroundColor: inlineBackgroundColor,
            color: inlineTextColor,
            borderRadius: 5,
            paddingHorizontal: 5,
            paddingVertical: 1,
            fontFamily: "ui-monospace",
            fontSize: 13,
          }}
        >
          {content}
        </NativeText>
      ),
      code_block: ({ content }) => (
        <View
          style={{
            backgroundColor: blockBackgroundColor,
            borderRadius: 12,
            padding: 12,
            marginVertical: 8,
          }}
        >
          <ScrollView horizontal showsHorizontalScrollIndicator={false} bounces={false}>
            <NativeText
              selectable
              style={{
                color: blockTextColor,
                fontFamily: "ui-monospace",
                fontSize: 13,
                lineHeight: 19,
              }}
            >
              {content}
            </NativeText>
          </ScrollView>
        </View>
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
        fontFamily: "DMSans_700Bold",
      },
      heading: {
        ...baseStyles.heading,
        color: markdownUserBodyColor,
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
        renderers: createCodeRenderers(
          markdownUserCodeBg,
          markdownUserCodeText,
          markdownUserFenceBg,
          markdownUserFenceText,
        ),
      },
      assistant: {
        theme: assistantTheme,
        styles: assistantStyles,
        renderers: createCodeRenderers(
          markdownCodeBg,
          markdownCodeText,
          markdownCodeBg,
          markdownCodeText,
        ),
      },
    };
  }, [
    blockquoteBg,
    blockquoteBorder,
    bodyColor,
    codeBg,
    codeText,
    hrColor,
    linkColor,
    strongColor,
    userBodyColor,
    userCodeBg,
    userCodeText,
    userFenceBg,
    userFenceText,
  ]);
}

function renderFeedEntry(
  info: { item: ThreadFeedEntry; index: number },
  props: Pick<ThreadFeedProps, "bearerToken" | "httpBaseUrl"> & {
    readonly copiedRowId: string | null;
    readonly expandedWorkGroups: Record<string, boolean>;
    readonly onCopyWorkRow: (rowId: string, value: string) => void;
    readonly onToggleWorkGroup: (groupId: string) => void;
    readonly onPressImage: (uri: string, headers?: Record<string, string>) => void;
    readonly iconSubtleColor: string | import("react-native").ColorValue;
    readonly userBubbleColor: string | import("react-native").ColorValue;
    readonly markdownStyles: MarkdownStyleSets;
    readonly reviewCommentColors: ReviewCommentColors;
    readonly reviewCommentBubbleWidth: number;
  },
) {
  const entry = info.item;
  const { markdownStyles, iconSubtleColor, userBubbleColor } = props;

  if (entry.type === "message") {
    const { message } = entry;
    const isUser = message.role === "user";
    const styles = isUser ? markdownStyles.user : markdownStyles.assistant;
    const timestampLabel = `${relativeTime(message.createdAt)}${message.streaming ? " • live" : ""}`;
    const attachments = message.attachments ?? [];
    const hasReviewCommentContext = message.text.includes("<review_comment");

    if (isUser) {
      return (
        <View className="mb-5 items-end">
          <View
            className="max-w-[85%] gap-2 rounded-[22px] rounded-br-[6px] px-3.5 py-2.5"
            style={{
              backgroundColor: userBubbleColor,
              ...(hasReviewCommentContext ? { width: props.reviewCommentBubbleWidth } : null),
            }}
          >
            {message.text.trim().length > 0 ? (
              <UserMessageContent
                text={message.text}
                markdownStyles={styles}
                reviewCommentColors={props.reviewCommentColors}
              />
            ) : null}
            {attachments.map((attachment) => {
              const uri = messageImageUrl(props.httpBaseUrl, attachment.id);
              if (!uri) {
                return null;
              }
              const headers = props.bearerToken
                ? { Authorization: `Bearer ${props.bearerToken}` }
                : undefined;

              return (
                <TouchableOpacity
                  key={attachment.id}
                  activeOpacity={0.7}
                  onPress={() => props.onPressImage(uri, headers)}
                >
                  <Image
                    source={{ uri, ...(headers ? { headers } : {}) }}
                    className="aspect-[1.3] w-full rounded-[14px] bg-white/15"
                    resizeMode="cover"
                  />
                </TouchableOpacity>
              );
            })}
          </View>
          <Text className="mt-1.5 px-1 text-right font-t3-medium text-xs text-neutral-600 dark:text-neutral-400">
            {timestampLabel}
          </Text>
        </View>
      );
    }

    // Skip empty assistant messages (no text, no attachments) — they would
    // render as an orphaned timestamp and break adjacent activity-group merging.
    if (message.text.trim().length === 0 && attachments.length === 0) {
      return null;
    }

    return (
      <View className="mb-5 px-1">
        {message.text.trim().length > 0 ? (
          <Markdown
            options={{ gfm: true }}
            renderers={styles.renderers}
            styles={styles.styles}
            theme={styles.theme}
          >
            {message.text}
          </Markdown>
        ) : null}
        {attachments.map((attachment) => {
          const uri = messageImageUrl(props.httpBaseUrl, attachment.id);
          if (!uri) {
            return null;
          }
          const headers = props.bearerToken
            ? { Authorization: `Bearer ${props.bearerToken}` }
            : undefined;

          return (
            <TouchableOpacity
              key={attachment.id}
              activeOpacity={0.7}
              className="mt-1.5"
              onPress={() => props.onPressImage(uri, headers)}
            >
              <Image
                source={{ uri, ...(headers ? { headers } : {}) }}
                className="aspect-[1.3] w-full rounded-[18px] bg-neutral-200 dark:bg-neutral-800"
                resizeMode="cover"
              />
            </TouchableOpacity>
          );
        })}
        <Text className="mt-1.5 font-t3-medium text-xs text-neutral-600 dark:text-neutral-400">
          {timestampLabel}
        </Text>
      </View>
    );
  }

  if (entry.type === "queued-message") {
    return (
      <View className="mb-5 items-end">
        <View
          className="max-w-[85%] gap-2 rounded-[22px] rounded-br-[6px] px-3.5 py-2.5 opacity-60"
          style={{ backgroundColor: userBubbleColor }}
        >
          <Text className="font-sans text-[15px] leading-[22px] text-white">
            {entry.queuedMessage.text}
          </Text>
          {entry.queuedMessage.attachments.length > 0 ? (
            <Text className="font-t3-medium text-xs text-white/75">
              {entry.queuedMessage.attachments.length} image
              {entry.queuedMessage.attachments.length === 1 ? "" : "s"} attached
            </Text>
          ) : null}
        </View>
        <Text className="mt-1.5 px-1 text-right font-t3-medium text-xs text-neutral-600 dark:text-neutral-400">
          {entry.sending ? "dispatching" : `${relativeTime(entry.createdAt)} • pending`}
        </Text>
      </View>
    );
  }

  const rows = buildActivityRows(entry.activities);
  const isExpanded = props.expandedWorkGroups[entry.id] ?? false;
  const hasOverflow = rows.length > MAX_VISIBLE_WORK_LOG_ENTRIES;
  const visibleRows = hasOverflow && !isExpanded ? rows.slice(-MAX_VISIBLE_WORK_LOG_ENTRIES) : rows;
  const hiddenCount = rows.length - visibleRows.length;
  const showHeader = hasOverflow;

  return (
    <View className="mb-3 rounded-[20px] border border-neutral-200/80 bg-neutral-50/85 px-3 py-2 dark:border-white/[0.06] dark:bg-white/[0.025]">
      {showHeader ? (
        <View className="mb-1.5 flex-row items-center justify-between gap-3 px-0.5">
          <Text className="font-t3-bold text-[10px] uppercase tracking-[0.8px] text-neutral-500 dark:text-neutral-500">
            Tool calls ({rows.length})
          </Text>
          <Pressable onPress={() => props.onToggleWorkGroup(entry.id)}>
            <Text className="font-t3-medium text-[10px] uppercase tracking-[0.8px] text-neutral-500 dark:text-neutral-500">
              {isExpanded ? "Show less" : `Show ${hiddenCount} more`}
            </Text>
          </Pressable>
        </View>
      ) : null}
      {visibleRows.map((row, index) => (
        <View
          key={row.id}
          className={cn(
            "flex-row items-center gap-2 rounded-lg px-1 py-1",
            index > 0 && "border-t border-neutral-200/80 dark:border-white/[0.06]",
          )}
        >
          <View className="items-center justify-center pt-0.5">
            <SymbolView name="terminal" size={13} tintColor={iconSubtleColor} type="monochrome" />
          </View>
          <ScrollView
            horizontal
            nestedScrollEnabled
            directionalLockEnabled
            showsHorizontalScrollIndicator={false}
            bounces={false}
            className="flex-1"
            contentContainerStyle={{ paddingRight: 12 }}
            style={{ flex: 1 }}
          >
            <Text
              className="text-[12px] leading-[18px] text-neutral-600 dark:text-neutral-400"
              onLongPress={() => {
                const copyValue = row.detail ?? row.summary;
                props.onCopyWorkRow(row.id, copyValue);
              }}
              style={{
                fontFamily: "ui-monospace, SFMono-Regular, SF Mono, Menlo, Consolas, monospace",
              }}
            >
              {row.detail ? `${row.summary} - ${row.detail}` : row.summary}
            </Text>
          </ScrollView>
          {props.copiedRowId === row.id ? (
            <Text className="shrink-0 font-t3-medium text-[10px] uppercase tracking-[0.8px] text-emerald-600 dark:text-emerald-400">
              Copied
            </Text>
          ) : null}
        </View>
      ))}
    </View>
  );
}

function UserMessageContent(props: {
  readonly text: string;
  readonly markdownStyles: MarkdownStyleSet;
  readonly reviewCommentColors: ReviewCommentColors;
}) {
  const segments = parseReviewCommentMessageSegments(props.text);
  const hasReviewComment = segments.some((segment) => segment.kind === "review-comment");
  if (!hasReviewComment) {
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

        return (
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
  const nativeStyleJson = useMemo(() => JSON.stringify(NATIVE_REVIEW_DIFF_STYLE), []);
  const nativeDiffHeight = useMemo(
    () =>
      Math.min(
        360,
        Math.max(
          112,
          compactNativeRows.length * NATIVE_REVIEW_DIFF_ROW_HEIGHT +
            NATIVE_REVIEW_DIFF_STYLE.fileHeaderVerticalMargin,
        ),
      ),
    [compactNativeRows.length],
  );
  const shouldRenderNativeDiff = NativeReviewDiffView != null && compactNativeRows.length > 0;

  return (
    <View
      className="w-full overflow-hidden rounded-[16px] border"
      style={{
        backgroundColor: props.colors.background,
        borderColor: props.colors.border,
        borderCurve: "continuous",
      }}
    >
      <View
        className="flex-row items-center gap-2 border-b px-3 py-2"
        style={{ borderColor: props.colors.border }}
      >
        <View
          className="size-6 items-center justify-center rounded-[7px]"
          style={{ backgroundColor: props.colors.mutedBackground, borderCurve: "continuous" }}
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
            className="font-mono text-[12px] leading-[16px]"
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
            style={StyleSheet.absoluteFillObject}
            appearanceScheme={appearanceScheme}
            contentWidth={NATIVE_REVIEW_DIFF_CONTENT_WIDTH}
            rowHeight={NATIVE_REVIEW_DIFF_ROW_HEIGHT}
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
            style={{
              color: props.colors.text,
              fontFamily: "ui-monospace",
              fontSize: 12,
              lineHeight: 18,
            }}
          >
            {props.comment.diff.trim()}
          </NativeText>
        </ScrollView>
      ) : null}
      {props.comment.text.length > 0 ? (
        <View className="border-t px-3 py-3" style={{ borderColor: props.colors.border }}>
          <Text
            selectable
            className="text-[15px] leading-[21px]"
            style={{ color: props.colors.text }}
          >
            {props.comment.text}
          </Text>
        </View>
      ) : null}
    </View>
  );
});

function buildReviewCommentPatch(comment: ReviewInlineComment): string {
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

const IOS_NAV_BAR_HEIGHT = 44;

export const ThreadFeed = memo(function ThreadFeed(props: ThreadFeedProps) {
  const listRef = useRef<LegendListRef>(null);
  const copyFeedbackTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const { width: viewportWidth } = useWindowDimensions();
  const [copiedRowId, setCopiedRowId] = useState<string | null>(null);
  const [expandedWorkGroups, setExpandedWorkGroups] = useState<Record<string, boolean>>({});
  const [expandedImage, setExpandedImage] = useState<{
    uri: string;
    headers?: Record<string, string>;
  } | null>(null);
  const horizontalPadding = props.layoutVariant === "split" ? 20 : 16;
  const contentWidth = Math.max(0, viewportWidth - horizontalPadding * 2);
  const reviewCommentBubbleWidth = Math.min(Math.max(280, contentWidth * 0.85), contentWidth);
  const insets = useSafeAreaInsets();
  const topContentInset = insets.top + IOS_NAV_BAR_HEIGHT;
  const bottomContentInset = props.contentBottomInset ?? 18;

  const iconSubtleColor = useThemeColor("--color-icon-subtle");
  const userBubbleColor = useThemeColor("--color-user-bubble");
  const markdownStyles = useMarkdownStyles();
  const reviewCommentColors = useReviewCommentColors();

  useEffect(() => {
    setCopiedRowId(null);
    setExpandedWorkGroups({});
  }, [props.threadId]);

  useEffect(() => {
    return () => {
      if (copyFeedbackTimeoutRef.current) {
        clearTimeout(copyFeedbackTimeoutRef.current);
      }
    };
  }, []);

  const onCopyWorkRow = useCallback((rowId: string, value: string) => {
    void Clipboard.setStringAsync(value);
    void Haptics.selectionAsync();
    setCopiedRowId(rowId);
    if (copyFeedbackTimeoutRef.current) {
      clearTimeout(copyFeedbackTimeoutRef.current);
    }
    copyFeedbackTimeoutRef.current = setTimeout(() => {
      setCopiedRowId((current) => (current === rowId ? null : current));
      copyFeedbackTimeoutRef.current = null;
    }, 1200);
  }, []);

  const onToggleWorkGroup = useCallback((groupId: string) => {
    setExpandedWorkGroups((current) => ({
      ...current,
      [groupId]: !(current[groupId] ?? false),
    }));
  }, []);

  const onPressImage = useCallback((uri: string, headers?: Record<string, string>) => {
    setExpandedImage({ uri, headers });
  }, []);

  const renderItem = useCallback(
    (info: { item: ThreadFeedEntry; index: number }) =>
      renderFeedEntry(info, {
        bearerToken: props.bearerToken,
        copiedRowId,
        httpBaseUrl: props.httpBaseUrl,
        expandedWorkGroups,
        onCopyWorkRow,
        onToggleWorkGroup,
        onPressImage,
        iconSubtleColor,
        userBubbleColor,
        markdownStyles,
        reviewCommentColors,
        reviewCommentBubbleWidth,
      }),
    [
      copiedRowId,
      expandedWorkGroups,
      iconSubtleColor,
      userBubbleColor,
      markdownStyles,
      reviewCommentColors,
      reviewCommentBubbleWidth,
      onCopyWorkRow,
      onPressImage,
      onToggleWorkGroup,
      props.bearerToken,
      props.httpBaseUrl,
    ],
  );

  if (props.feed.length === 0) {
    return (
      <ScrollView
        style={{ flex: 1 }}
        contentInsetAdjustmentBehavior="never"
        contentInset={{ top: topContentInset, bottom: bottomContentInset }}
        contentOffset={{ x: 0, y: -topContentInset }}
        scrollIndicatorInsets={{ top: topContentInset, bottom: bottomContentInset }}
        contentContainerStyle={{
          flexGrow: 1,
          paddingHorizontal: horizontalPadding,
        }}
      >
        <EmptyState
          title="No conversation yet"
          detail="Ask the agent to inspect the repo, run a command, or continue the active thread."
        />
      </ScrollView>
    );
  }

  return (
    <>
      <KeyboardAvoidingLegendList
        ref={listRef}
        key={props.threadId}
        style={{ flex: 1 }}
        alignItemsAtEnd
        contentInsetAdjustmentBehavior="never"
        contentInset={{ top: topContentInset, bottom: bottomContentInset }}
        scrollIndicatorInsets={{ top: topContentInset, bottom: bottomContentInset }}
        data={props.feed as ThreadFeedEntry[]}
        renderItem={renderItem}
        keyExtractor={(entry) => `${entry.type}:${entry.id}`}
        getItemType={(entry) =>
          entry.type === "message" ? `message:${entry.message.role}` : entry.type
        }
        keyboardShouldPersistTaps="handled"
        estimatedItemSize={180}
        initialScrollAtEnd
        maintainScrollAtEnd={{
          on: { layout: true, itemLayout: true, dataChange: true },
        }}
        maintainScrollAtEndThreshold={0.1}
        refreshing={props.refreshing ?? false}
        onRefresh={props.onRefresh}
        safeAreaInsetBottom={insets.bottom}
        contentContainerStyle={{
          paddingTop: 12,
          paddingHorizontal: horizontalPadding,
        }}
      />

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

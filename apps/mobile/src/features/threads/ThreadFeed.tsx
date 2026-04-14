import * as Clipboard from "expo-clipboard";
import * as Haptics from "expo-haptics";
import { KeyboardAvoidingLegendList } from "@legendapp/list/keyboard";
import { type LegendListRef } from "@legendapp/list/react-native";
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
  Text as NativeText,
  type ColorValue,
  View,
} from "react-native";
import { TouchableOpacity } from "react-native-gesture-handler";
import ImageViewing from "react-native-image-viewing";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useThemeColor } from "../../lib/useThemeColor";

import { AppText as Text } from "../../components/AppText";
import { EmptyState } from "../../components/EmptyState";
import { cn } from "../../lib/cn";
import type { MobileLayoutVariant } from "../../lib/mobileLayout";
import type { ThreadFeedEntry } from "../../lib/threadActivity";
import { relativeTime } from "../../lib/time";
import { messageImageUrl } from "./threadPresentation";

export interface ThreadFeedProps {
  readonly threadId: string;
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

function useMarkdownStyles(): MarkdownStyleSets {
  const bodyColor = useThemeColor("--color-md-body");
  const strongColor = useThemeColor("--color-md-strong");
  const linkColor = useThemeColor("--color-md-link");
  const blockquoteBg = useThemeColor("--color-md-blockquote-bg");
  const blockquoteBorder = useThemeColor("--color-md-blockquote-border");
  const codeBg = useThemeColor("--color-md-code-bg");
  const codeText = useThemeColor("--color-md-code-text");
  const hrColor = useThemeColor("--color-md-hr");
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
      bold: { fontWeight: "700", color: markdownStrongColor, fontFamily: "DMSans_700Bold" },
      italic: { fontStyle: "italic" },
      link: { color: markdownLinkColor, textDecorationLine: "underline" as const },
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
        code: markdownUserCodeText,
        codeBackground: markdownUserCodeBg,
        border: markdownUserFenceBg,
      },
    };
    const userStyles: NodeStyleOverrides = {
      ...baseStyles,
      paragraph: { marginTop: 0, marginBottom: 0 },
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
    readonly markdownStyles: MarkdownStyleSets;
  },
) {
  const entry = info.item;
  const { markdownStyles, iconSubtleColor } = props;

  if (entry.type === "message") {
    const { message } = entry;
    const isUser = message.role === "user";
    const styles = isUser ? markdownStyles.user : markdownStyles.assistant;
    const timestampLabel = `${relativeTime(message.createdAt)}${message.streaming ? " • live" : ""}`;
    const attachments = message.attachments ?? [];

    if (isUser) {
      return (
        <View className="mb-3.5 items-end gap-1.5">
          <View className="max-w-[85%] gap-2 rounded-[22px] rounded-br-[10px] border border-blue-300/50 bg-blue-50/80 px-4 py-4 dark:border-blue-400/20 dark:bg-blue-500/12">
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
          </View>
          <Text className="px-1 text-right font-t3-medium text-xs text-neutral-500 dark:text-neutral-500">
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
      <View className="mb-3.5 gap-1.5 px-1">
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
        <Text className="font-t3-medium text-xs text-neutral-500 dark:text-neutral-500">
          {timestampLabel}
        </Text>
      </View>
    );
  }

  if (entry.type === "queued-message") {
    return (
      <View className="mb-3.5 gap-1.5 items-end">
        <View className="max-w-[85%] gap-2 rounded-[22px] rounded-br-[10px] border border-sky-300/60 bg-sky-100/75 px-4 py-4 dark:border-sky-300/20 dark:bg-sky-400/10">
          <Text className="font-sans text-[15px] leading-[22px] text-neutral-950 dark:text-neutral-50">
            {entry.queuedMessage.text}
          </Text>
          {entry.queuedMessage.attachments.length > 0 ? (
            <Text className="font-t3-medium text-xs text-neutral-500 dark:text-neutral-500">
              {entry.queuedMessage.attachments.length} image
              {entry.queuedMessage.attachments.length === 1 ? "" : "s"} attached
            </Text>
          ) : null}
        </View>
        <Text className="px-1 text-right font-t3-medium text-xs text-neutral-500 dark:text-neutral-500">
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

const IOS_NAV_BAR_HEIGHT = 44;

export const ThreadFeed = memo(function ThreadFeed(props: ThreadFeedProps) {
  const listRef = useRef<LegendListRef>(null);
  const copyFeedbackTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [copiedRowId, setCopiedRowId] = useState<string | null>(null);
  const [expandedWorkGroups, setExpandedWorkGroups] = useState<Record<string, boolean>>({});
  const [expandedImage, setExpandedImage] = useState<{
    uri: string;
    headers?: Record<string, string>;
  } | null>(null);
  const horizontalPadding = props.layoutVariant === "split" ? 20 : 16;
  const insets = useSafeAreaInsets();
  const topContentInset = insets.top + IOS_NAV_BAR_HEIGHT;

  const iconSubtleColor = useThemeColor("--color-icon-subtle");
  const markdownStyles = useMarkdownStyles();

  useEffect(() => {
    setCopiedRowId(null);
    setExpandedWorkGroups({});
  }, [props.threadId]);

  // Scroll to end when the composer expands (keyboard opens) so the latest
  // message stays visible above the taller composer + keyboard.
  useEffect(() => {
    if (props.composerExpanded && props.feed.length > 0) {
      // Small delay to let KAV + layout settle before scrolling
      const timer = setTimeout(() => {
        void listRef.current?.scrollToEnd({ animated: true });
      }, 100);
      return () => clearTimeout(timer);
    }
  }, [props.composerExpanded, props.feed.length]);

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
        markdownStyles,
      }),
    [
      copiedRowId,
      expandedWorkGroups,
      iconSubtleColor,
      markdownStyles,
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
        contentInset={{ top: topContentInset }}
        contentOffset={{ x: 0, y: -topContentInset }}
        scrollIndicatorInsets={{ top: topContentInset }}
        contentContainerStyle={{
          flexGrow: 1,
          paddingHorizontal: horizontalPadding,
          paddingBottom: props.contentBottomInset ?? 18,
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
        contentInset={{ top: topContentInset }}
        scrollIndicatorInsets={{ top: topContentInset }}
        data={props.feed as ThreadFeedEntry[]}
        renderItem={renderItem}
        keyExtractor={(entry) => `${entry.type}:${entry.id}`}
        keyboardShouldPersistTaps="handled"
        estimatedItemSize={80}
        initialScrollAtEnd
        maintainScrollAtEnd={{ on: { layout: true, itemLayout: true, dataChange: true } }}
        maintainScrollAtEndThreshold={0.1}
        refreshing={props.refreshing ?? false}
        onRefresh={props.onRefresh}
        safeAreaInsetBottom={insets.bottom}
        contentContainerStyle={{
          paddingTop: 12,
          paddingHorizontal: horizontalPadding,
          paddingBottom: props.contentBottomInset ?? 18,
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

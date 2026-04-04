import { FlashList, type FlashListRef, type ListRenderItemInfo } from "@shopify/flash-list";
import { memo, useCallback, useEffect, useRef } from "react";
import Markdown from "react-native-markdown-display";
import {
  ActivityIndicator,
  Image,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  View,
} from "react-native";

import { AppText as Text } from "../../components/AppText";
import { EmptyState } from "../../components/EmptyState";
import { cx } from "../../lib/classNames";
import type { ThreadFeedEntry } from "../../lib/threadActivity";
import { relativeTime } from "../../lib/time";
import { messageImageUrl } from "./threadPresentation";

export interface ThreadFeedProps {
  readonly threadId: string;
  readonly feed: ReadonlyArray<ThreadFeedEntry>;
  readonly loadingInitial: boolean;
  readonly loadingMore: boolean;
  readonly hasMore: boolean;
  readonly httpOrigin: string | null;
  readonly authToken: string | null;
  readonly agentLabel: string;
  readonly contentTopInset?: number;
  readonly contentBottomInset?: number;
  readonly onLoadMore: () => Promise<void>;
}

function FeedLoadingState(props: { readonly label: string }) {
  return (
    <View className="items-center justify-center gap-3 rounded-[22px] border border-slate-200 bg-white px-5 py-6">
      <ActivityIndicator size="small" />
      <Text className="text-sm font-bold text-slate-500">{props.label}</Text>
    </View>
  );
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

  const cleaned = stripShellWrapper(detail);
  return cleaned.length > 0 ? cleaned : null;
}

function buildActivityRows(
  activities: ReadonlyArray<{
    readonly id: string;
    readonly summary: string;
    readonly detail: string | null;
    readonly status: string | null;
  }>,
) {
  const rows: Array<{
    id: string;
    label: string;
    detail: string | null;
    status: string | null;
  }> = [];

  for (const activity of activities) {
    const detail = compactActivityDetail(activity.detail);
    const label = detail ?? activity.summary;
    const previous = rows.at(-1);

    if (previous && previous.label === label) {
      rows[rows.length - 1] = {
        ...previous,
        detail,
        status: activity.status ?? previous.status,
      };
      continue;
    }

    rows.push({
      id: activity.id,
      label,
      detail,
      status: activity.status,
    });
  }

  return rows;
}

const MARKDOWN_BASE = {
  body: {
    color: "#020617",
    fontSize: 15,
    lineHeight: 22,
  },
  paragraph: { marginTop: 0, marginBottom: 0 },
  bullet_list: { marginTop: 0, marginBottom: 0 },
  ordered_list: { marginTop: 0, marginBottom: 0 },
  list_item: { marginTop: 0, marginBottom: 2 },
  strong: { fontWeight: "800" as const, color: "#020617" },
  em: { fontStyle: "italic" as const },
  link: { color: "#0369a1" },
  blockquote: {
    borderLeftWidth: 3,
    borderLeftColor: "rgba(100,116,139,0.35)",
    paddingLeft: 12,
    marginLeft: 0,
  },
};

const USER_MARKDOWN_STYLES = {
  ...MARKDOWN_BASE,
  code_inline: {
    backgroundColor: "rgba(255,255,255,0.55)",
    color: "#0f172a",
    borderRadius: 6,
    paddingHorizontal: 6,
    paddingVertical: 2,
  },
  code_block: {
    backgroundColor: "rgba(255,255,255,0.6)",
    color: "#0f172a",
    borderRadius: 14,
    padding: 12,
  },
  fence: {
    backgroundColor: "rgba(255,255,255,0.6)",
    color: "#0f172a",
    borderRadius: 14,
    padding: 12,
  },
};

const ASSISTANT_MARKDOWN_STYLES = {
  ...MARKDOWN_BASE,
  code_inline: {
    backgroundColor: "rgba(15,23,42,0.08)",
    color: "#0f172a",
    borderRadius: 6,
    paddingHorizontal: 6,
    paddingVertical: 2,
  },
  code_block: {
    backgroundColor: "rgba(15,23,42,0.08)",
    color: "#0f172a",
    borderRadius: 14,
    padding: 12,
  },
  fence: {
    backgroundColor: "rgba(15,23,42,0.08)",
    color: "#0f172a",
    borderRadius: 14,
    padding: 12,
  },
};

function renderFeedEntry(
  info: ListRenderItemInfo<ThreadFeedEntry>,
  props: Pick<ThreadFeedProps, "agentLabel" | "authToken" | "httpOrigin">,
) {
  const entry = info.item;

  if (entry.type === "message") {
    const { message } = entry;
    const isUser = message.role === "user";
    const markdownStyles = isUser ? USER_MARKDOWN_STYLES : ASSISTANT_MARKDOWN_STYLES;

    return (
      <View
        className={cx(
          "mb-3.5 gap-2.5 rounded-[22px] border px-4 py-4",
          isUser
            ? "border-orange-300/60 bg-orange-100/70 dark:border-orange-300/22 dark:bg-orange-300/14"
            : "border-slate-200 bg-slate-100/80 dark:border-white/6 dark:bg-slate-900/80",
        )}
      >
        <View className="flex-row justify-between gap-3">
          <Text className="font-t3-bold text-[13px] text-slate-950 dark:text-slate-50">
            {isUser ? "You" : props.agentLabel}
          </Text>
          <Text className="font-t3-medium text-xs text-slate-500 dark:text-slate-500">
            {relativeTime(message.createdAt)}
            {message.streaming ? " • live" : ""}
          </Text>
        </View>
        {message.text.trim().length > 0 ? (
          <Markdown style={markdownStyles}>{message.text}</Markdown>
        ) : null}
        {message.attachments?.map((attachment) => {
          const uri = messageImageUrl(props.httpOrigin, attachment.id, props.authToken);
          if (!uri) {
            return null;
          }

          return (
            <Image
              key={attachment.id}
              source={{ uri }}
              className="aspect-[1.3] w-full rounded-[18px] bg-slate-200 dark:bg-slate-800"
              resizeMode="cover"
            />
          );
        })}
      </View>
    );
  }

  if (entry.type === "queued-message") {
    return (
      <View className="mb-3.5 gap-2.5 rounded-[22px] border border-sky-300/60 bg-sky-100/75 px-4 py-4 dark:border-sky-300/20 dark:bg-sky-400/10">
        <View className="flex-row justify-between gap-3">
          <Text className="font-t3-bold text-[13px] text-slate-950 dark:text-slate-50">
            {entry.sending ? "Sending next" : "Queued"}
          </Text>
          <Text className="font-t3-medium text-xs text-slate-500 dark:text-slate-500">
            {entry.sending ? "dispatching" : `${relativeTime(entry.createdAt)} • pending`}
          </Text>
        </View>
        <Text className="font-sans text-[15px] leading-[22px] text-slate-950 dark:text-slate-50">
          {entry.queuedMessage.text}
        </Text>
        {entry.queuedMessage.attachments.length > 0 ? (
          <Text className="font-t3-medium text-xs text-slate-500 dark:text-slate-500">
            {entry.queuedMessage.attachments.length} image
            {entry.queuedMessage.attachments.length === 1 ? "" : "s"} attached
          </Text>
        ) : null}
      </View>
    );
  }

  const rows = buildActivityRows(entry.activities);

  return (
    <View className="mb-3.5 gap-3 rounded-[22px] border border-slate-200/80 bg-slate-50/85 px-4 py-4 dark:border-white/4 dark:bg-white/[0.025]">
      <View className="flex-row items-center justify-between gap-3 pb-0.5">
        <Text className="font-t3-bold text-[11px] uppercase tracking-[0.8px] text-slate-500 dark:text-slate-500">
          Command center
        </Text>
        <Text className="font-t3-medium text-[11px] text-slate-500 dark:text-slate-500">
          {relativeTime(entry.createdAt)}
        </Text>
      </View>
      {rows.map((row, index) => (
        <View
          key={row.id}
          className={cx(
            "gap-1.5 py-2",
            index > 0 && "border-t border-slate-200/80 dark:border-white/4",
          )}
        >
          <View className="flex-row items-start justify-between gap-3">
            <Text className="flex-1 font-t3-medium text-[14px] text-slate-700 dark:text-slate-200">
              {row.label}
            </Text>
            <Text className="font-t3-medium text-[11px] capitalize text-slate-500 dark:text-slate-500">
              {row.status ? row.status.replaceAll("_", " ") : "done"}
            </Text>
          </View>
          {row.detail && row.detail !== row.label ? (
            <Text className="font-sans text-xs leading-[18px] text-slate-500 dark:text-slate-500">
              {row.detail}
            </Text>
          ) : null}
        </View>
      ))}
    </View>
  );
}

function useAutoScrollToLatest(
  listRef: React.RefObject<FlashListRef<ThreadFeedEntry> | null>,
  threadId: string,
  feed: ReadonlyArray<ThreadFeedEntry>,
) {
  const shouldFollowLatestRef = useRef(true);
  const previousThreadIdRef = useRef(threadId);
  const previousFeedLengthRef = useRef(feed.length);

  const updateFollowLatest = useCallback((event: NativeSyntheticEvent<NativeScrollEvent>) => {
    const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent;
    const distanceFromBottom = contentSize.height - (contentOffset.y + layoutMeasurement.height);
    shouldFollowLatestRef.current = distanceFromBottom <= 96;
  }, []);

  useEffect(() => {
    const isNewThread = previousThreadIdRef.current !== threadId;
    if (isNewThread) {
      previousThreadIdRef.current = threadId;
      previousFeedLengthRef.current = feed.length;
      shouldFollowLatestRef.current = true;
    }

    const feedGrew = feed.length >= previousFeedLengthRef.current;
    previousFeedLengthRef.current = feed.length;

    if (!shouldFollowLatestRef.current || (!feedGrew && !isNewThread)) {
      return;
    }

    requestAnimationFrame(() => {
      listRef.current?.scrollToEnd({
        animated: !isNewThread,
      });
    });
  }, [feed, feed.length, listRef, threadId]);

  return updateFollowLatest;
}

export const ThreadFeed = memo(function ThreadFeed(props: ThreadFeedProps) {
  const listRef = useRef<FlashListRef<ThreadFeedEntry>>(null);
  const updateFollowLatest = useAutoScrollToLatest(listRef, props.threadId, props.feed);

  if (props.loadingInitial) {
    return (
      <View
        className="flex-1 px-4"
        style={{
          minHeight: 0,
          paddingTop: props.contentTopInset ?? 18,
          paddingBottom: props.contentBottomInset ?? 18,
        }}
      >
        <FeedLoadingState label="Loading conversation…" />
      </View>
    );
  }

  if (props.feed.length === 0) {
    return (
      <View
        className="flex-1 px-4"
        style={{
          minHeight: 0,
          paddingTop: props.contentTopInset ?? 18,
          paddingBottom: props.contentBottomInset ?? 18,
        }}
      >
        <EmptyState
          title="No conversation yet"
          detail="Ask the agent to inspect the repo, run a command, or continue the active thread."
        />
      </View>
    );
  }

  return (
    <View className="flex-1" style={{ minHeight: 0 }}>
      <FlashList
        ref={listRef}
        key={props.threadId}
        style={{ flex: 1 }}
        data={props.feed}
        renderItem={(info) => renderFeedEntry(info, props)}
        keyExtractor={(entry) => `${entry.type}:${entry.id}`}
        keyboardShouldPersistTaps="handled"
        onScroll={updateFollowLatest}
        scrollEventThrottle={16}
        onStartReached={
          props.hasMore && !props.loadingInitial && !props.loadingMore
            ? () => void props.onLoadMore()
            : undefined
        }
        onStartReachedThreshold={0.12}
        maintainVisibleContentPosition={{
          autoscrollToBottomThreshold: 0.2,
          animateAutoScrollToBottom: true,
          startRenderingFromBottom: true,
        }}
        contentContainerStyle={{
          paddingHorizontal: 16,
          paddingTop: props.contentTopInset ?? 18,
          paddingBottom: props.contentBottomInset ?? 18,
        }}
        ListHeaderComponent={
          props.loadingMore ? <FeedLoadingState label="Loading older messages…" /> : null
        }
      />
    </View>
  );
});

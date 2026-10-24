import { reviewThreadReplyTarget } from "@t3tools/client-runtime/review-editing";
import { useAtomRefresh } from "@effect/atom-react";
import { useNavigation } from "@react-navigation/native";
import { reviewLineRangeLabel } from "@t3tools/client-runtime/review-selection";
import {
  mergeReviewThreadComments,
  reviewThreadSummary,
} from "@t3tools/client-runtime/review-threads";
import type {
  PullRequestActor,
  PullRequestReaction,
  PullRequestReviewThread,
  PullRequestThreadComment,
} from "@t3tools/contracts";
import { useMemo, useRef, useState, type ReactNode } from "react";
import { Alert, Pressable, StyleSheet, View } from "react-native";
import Svg, { Defs, LinearGradient, Rect, Stop } from "react-native-svg";
import { SymbolView } from "../../components/ui/AppSymbol";
import { AppText as Text } from "../../components/ui/AppText";
import { relativeTime } from "../../lib/time";
import { composerPullRequests } from "../../state/pull-requests";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { useAppearancePreferences } from "../settings/appearance/AppearancePreferencesProvider";
import { PullRequestCommentComposer } from "./PullRequestCommentComposer";
import { PullRequestCommentControls } from "./PullRequestCommentControls";
import { PullRequestMarkdown } from "./PullRequestMarkdown";
import { PullRequestPendingBadge } from "./PullRequestPendingComment";
import { PullRequestAvatar } from "./PullRequestPresentation";
import { pullRequestTarget, type PullRequestParams } from "./usePullRequestDiff";
import { usePullRequestPermissions } from "./usePullRequestPermissions";

const LONG_BODY_CHARACTERS = 450;
const LONG_BODY_LINES = 8;

/** A comment body that folds very long remarks behind "Show more" so lists stay scannable. */
export function PullRequestCommentBody({ body }: { body: string }) {
  const [expanded, setExpanded] = useState(false);
  const { themeVariables: colors } = useAppearancePreferences();
  const long = body.length > LONG_BODY_CHARACTERS || body.split("\n").length > LONG_BODY_LINES;
  const folded = long && !expanded;
  const fill = colors["--color-grouped-card"];
  return (
    <View>
      <View style={folded ? { maxHeight: 220, overflow: "hidden" } : undefined}>
        <PullRequestMarkdown
          markdown={folded ? body.slice(0, 1200) : body}
          imageGroupMarkdown={body}
        />
      </View>
      {folded ? (
        <View
          pointerEvents="none"
          style={[StyleSheet.absoluteFill, { top: undefined, height: 72 }]}
        >
          <Svg width="100%" height={72}>
            <Defs>
              <LinearGradient
                id="comment-fade"
                x1="0"
                y1="0"
                x2="0"
                y2="72"
                gradientUnits="userSpaceOnUse"
              >
                <Stop offset="0" stopColor={fill} stopOpacity={0} />
                <Stop offset="0.6" stopColor={fill} stopOpacity={0.96} />
                <Stop offset="1" stopColor={fill} stopOpacity={1} />
              </LinearGradient>
            </Defs>
            <Rect width="100%" height="100%" fill="url(#comment-fade)" />
          </Svg>
        </View>
      ) : null}
      {long ? (
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ expanded }}
          onPress={() => setExpanded(!expanded)}
          hitSlop={8}
          className="flex-row items-center justify-center gap-1 pt-1 active:opacity-70"
        >
          <Text className="text-xs font-t3-medium text-foreground">
            {expanded ? "Show less" : "Show more"}
          </Text>
          <SymbolView
            name={expanded ? "chevron.up" : "chevron.down"}
            size={10}
            tintColorClassName="accent-foreground"
          />
        </Pressable>
      ) : null}
    </View>
  );
}

/**
 * One dense comment: author, time and actions on a single row, the body directly beneath. The
 * action slot keeps 44pt targets but pulls them into the row so they add no vertical gap.
 */
export function PullRequestCommentItem({
  params,
  comment,
  title,
  badges,
  meta,
  leadingAction,
  onResolve,
  onUnresolve,
}: {
  params: PullRequestParams;
  comment: {
    id: string;
    body: string;
    url: string | null;
    createdAt: string;
    author: PullRequestActor | null;
    reactions?: ReadonlyArray<PullRequestReaction> | undefined;
    kind?: string;
    canEdit?: boolean;
  };
  /** Muted verb after the author, such as "commented" or "approved". */
  title?: string | undefined;
  badges?: ReactNode;
  /** A second muted line, such as the file a remark was left on. */
  meta?: ReactNode;
  /** A direct action shown before the reaction and overflow controls. */
  leadingAction?: ReactNode;
  onResolve?: (() => void) | undefined;
  onUnresolve?: (() => void) | undefined;
}) {
  return (
    <PullRequestCommentControls
      params={params}
      comment={comment}
      onResolve={onResolve}
      onUnresolve={onUnresolve}
      render={({ actions, reactions }) => (
        <View className="gap-1.5 px-3 py-2.5">
          <View className="min-h-6 flex-row items-center gap-2">
            <PullRequestAvatar actor={comment.author} size={20} />
            <Text className="min-w-0 shrink text-xs" numberOfLines={1}>
              <Text className="font-t3-medium">
                {comment.author?.name ?? comment.author?.login ?? "Unknown author"}
              </Text>
              {title ? <Text className="text-foreground-muted"> {title}</Text> : null}
            </Text>
            <Text className="text-2xs text-foreground-muted">
              {relativeTime(comment.createdAt)}
            </Text>
            {badges}
            <View className="-my-2.5 ml-auto flex-row items-center">
              {leadingAction}
              {actions}
            </View>
          </View>
          {meta}
          {comment.body.trim() ? <PullRequestCommentBody body={comment.body} /> : null}
          {reactions}
        </View>
      )}
    />
  );
}

/** Icon-only action that matches the reaction and overflow controls beside it. */
function InlineIconAction({
  icon,
  label,
  onPress,
  disabled,
}: {
  icon: "checkmark" | "arrow.uturn.backward";
  label: string;
  onPress: () => void;
  disabled?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      disabled={disabled}
      onPress={onPress}
      className="min-h-11 min-w-11 items-center justify-center active:opacity-70"
    >
      <SymbolView name={icon} size={16} tintColorClassName="accent-icon-muted" />
    </Pressable>
  );
}

/**
 * Host operations for one review conversation. Resolution goes through the shared optimistic
 * command, so every card, count, and tab reflects it before the host answers and rolls back on
 * failure; only the error needs reporting here.
 */
export function usePullRequestThreadActions(
  params: PullRequestParams,
  thread: PullRequestReviewThread,
) {
  const target = pullRequestTarget(params);
  const detail = useEnvironmentQuery(composerPullRequests.detail(target));
  const permissions = usePullRequestPermissions(params, detail.data);
  const refresh = useAtomRefresh(composerPullRequests.activity(target));
  const replyCommand = useAtomCommand(composerPullRequests.replyToThread, {
    reportFailure: false,
  });
  const resolveCommand = useAtomCommand(composerPullRequests.setThreadResolution, {
    reportFailure: false,
  });
  const loadCommand = useAtomCommand(composerPullRequests.threadComments, {
    reportFailure: false,
  });
  const hasPending = thread.comments.some((comment) => comment.pendingReviewId);
  return {
    canReply: permissions.canReply,
    canResolve: permissions.canResolve && thread.canResolve !== false && !hasPending,
    toggleResolved: () => {
      const resolved = !thread.isResolved;
      void resolveCommand({
        ...target,
        input: { ...target.input, threadId: thread.id, resolved },
      }).then((result) => {
        if (result._tag === "Failure")
          Alert.alert(
            resolved ? "Could not resolve the conversation" : "Could not reopen the conversation",
            "Its previous state has been restored. Try again.",
          );
      });
    },
    /** Resolves to whether the host took it, so a failed reply keeps its words. */
    reply: async (body: string) => {
      const result = await replyCommand({
        ...target,
        input: { ...target.input, ...reviewThreadReplyTarget(thread), body },
      });
      if (result._tag === "Failure") {
        Alert.alert("Reply could not be posted", "Your reply has been kept. Try again.");
        return false;
      }
      refresh();
      return true;
    },
    loadMore: async (cursor: string) => {
      const result = await loadCommand({
        ...target,
        input: { ...target.input, threadId: thread.id, cursor },
      });
      if (result._tag === "Failure") {
        Alert.alert("More comments could not be loaded");
        return null;
      }
      return result.value;
    },
  };
}

/**
 * A review conversation as one card, shared by the Comments sheet, the Overview timeline, and the
 * discussion screen. It follows desktop's floating panel: a summary header that folds the thread,
 * dense comments, a direct Resolve on the first comment, and the reply field inside the card.
 * Resolved conversations open folded and fold again whenever they become resolved.
 */
export function PullRequestThreadCard({
  params,
  thread,
  showPath = true,
  defaultExpanded,
  autoFocusReply = false,
  onBeforeNavigate,
}: {
  params: PullRequestParams;
  thread: PullRequestReviewThread;
  showPath?: boolean;
  defaultExpanded?: boolean;
  autoFocusReply?: boolean;
  /** Lets a modal host dismiss itself before the file diff is pushed beneath it. */
  onBeforeNavigate?: () => void;
}) {
  const navigation = useNavigation();
  const actions = usePullRequestThreadActions(params, thread);
  const [expanded, setExpanded] = useState(defaultExpanded ?? !thread.isResolved);
  const [lastResolved, setLastResolved] = useState(thread.isResolved);
  if (lastResolved !== thread.isResolved) {
    setLastResolved(thread.isResolved);
    setExpanded(!thread.isResolved);
  }
  const [loadedPage, setLoadedPage] = useState<{
    readonly threadId: string;
    readonly comments: ReadonlyArray<PullRequestThreadComment>;
    readonly nextCursor: string | null;
  } | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [reply, setReply] = useState("");
  const [sending, setSending] = useState(false);
  const [uploading, setUploading] = useState(false);
  const sendingRef = useRef(false);
  const page = loadedPage?.threadId === thread.id ? loadedPage : null;
  const comments = useMemo(
    () => mergeReviewThreadComments(thread.comments, page?.comments ?? []),
    [thread.comments, page?.comments],
  );
  const nextCursor = page === null ? (thread.nextCommentsCursor ?? null) : page.nextCursor;
  const summary = reviewThreadSummary(thread);

  const send = async () => {
    const body = reply.trim();
    if (!body || sendingRef.current || uploading) return;
    sendingRef.current = true;
    setSending(true);
    return await (async () => {
      if (await actions.reply(body)) {
        // The mutation returns no comment; reopen the cursor so the reply stays reachable.
        setLoadedPage((previous) =>
          previous?.threadId === thread.id
            ? { ...previous, nextCursor: previous.nextCursor ?? thread.nextCommentsCursor ?? null }
            : previous,
        );
        setReply((current) => (current.trim() === body ? "" : current));
      }
    })().finally(async () => {
      sendingRef.current = false;
      setSending(false);
    });
  };
  const loadMore = async () => {
    if (nextCursor === null || loadingMore) return;
    setLoadingMore(true);
    return await (async () => {
      const result = await actions.loadMore(nextCursor);
      if (result === null) return;
      setLoadedPage((previous) => ({
        threadId: thread.id,
        comments: mergeReviewThreadComments(
          previous?.threadId === thread.id ? previous.comments : [],
          result.comments,
        ),
        nextCursor: result.nextCursor,
      }));
    })().finally(async () => {
      setLoadingMore(false);
    });
  };

  return (
    <View className="overflow-hidden rounded-xl border border-border-subtle bg-grouped-card">
      {showPath ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`View ${thread.path} diff`}
          onPress={() => {
            onBeforeNavigate?.();
            navigation.navigate("PullRequestFile", { ...params, path: thread.path });
          }}
          className="flex-row items-center gap-1.5 border-b border-border-subtle px-3 py-1.5 active:opacity-70"
        >
          <SymbolView name="doc.text" size={11} tintColorClassName="accent-icon-muted" />
          <Text
            className="min-w-0 flex-1 font-mono text-2xs text-foreground-muted"
            numberOfLines={1}
          >
            {thread.path}
            {thread.line === null ? "" : `:${thread.line}`}
          </Text>
          {thread.isOutdated ? (
            <Text className="text-2xs text-foreground-muted">Outdated</Text>
          ) : null}
        </Pressable>
      ) : null}
      <View className="min-h-10 flex-row items-center pr-1">
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ expanded }}
          accessibilityLabel={expanded && thread.isResolved ? "Collapse conversation" : summary}
          onPress={() => setExpanded(!expanded)}
          className="min-h-10 min-w-0 flex-1 flex-row items-center gap-2 pl-3 active:opacity-70"
        >
          <SymbolView
            name={thread.isResolved ? "checkmark.circle.fill" : "bubble.left"}
            size={13}
            tintColorClassName={
              thread.isResolved ? "accent-adaptive-emerald-600-400" : "accent-icon-muted"
            }
          />
          <Text className="min-w-0 shrink text-xs text-foreground-muted" numberOfLines={1}>
            {thread.isResolved && expanded ? "Collapse" : summary}
          </Text>
          {thread.line !== null ? (
            <Text className="text-2xs text-foreground-tertiary">
              {reviewLineRangeLabel(thread)}
            </Text>
          ) : null}
          <View className="flex-1" />
          <SymbolView
            name={expanded ? "chevron.up" : "chevron.down"}
            size={11}
            tintColorClassName="accent-icon-muted"
          />
        </Pressable>
        {thread.isResolved && actions.canResolve ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Unresolve conversation"
            onPress={actions.toggleResolved}
            className="-my-1 min-h-11 justify-center px-2 active:opacity-70"
          >
            <Text className="text-xs font-t3-medium text-foreground">Unresolve</Text>
          </Pressable>
        ) : (
          <View className="w-2" />
        )}
      </View>
      {expanded ? (
        <>
          {comments.map((comment, index) => (
            <View key={comment.id} className="border-t border-border-subtle">
              <PullRequestCommentItem
                params={params}
                comment={{ ...comment, url: comment.url ?? null }}
                badges={comment.pendingReviewId ? <PullRequestPendingBadge /> : null}
                leadingAction={
                  index === 0 && actions.canResolve && !thread.isResolved ? (
                    <InlineIconAction
                      icon="checkmark"
                      label="Resolve conversation"
                      onPress={actions.toggleResolved}
                    />
                  ) : null
                }
                onResolve={
                  actions.canResolve && !thread.isResolved ? actions.toggleResolved : undefined
                }
                onUnresolve={
                  actions.canResolve && thread.isResolved ? actions.toggleResolved : undefined
                }
              />
            </View>
          ))}
          {nextCursor !== null ? (
            <Pressable
              accessibilityRole="button"
              disabled={loadingMore}
              onPress={() => void loadMore()}
              className="min-h-10 justify-center border-t border-border-subtle px-3 active:opacity-70"
            >
              <Text className="text-xs font-t3-medium text-foreground-muted">
                {loadingMore ? "Loading…" : "Load more comments"}
              </Text>
            </Pressable>
          ) : null}
          {actions.canReply ? (
            <PullRequestCommentComposer
              params={params}
              variant="inline"
              label="Reply to this conversation"
              placeholder="Leave a reply…"
              value={reply}
              onChangeText={setReply}
              busy={sending}
              canSubmit={!sending && !uploading && Boolean(reply.trim())}
              submitLabel={sending ? "Posting…" : "Send reply"}
              onSubmit={() => void send()}
              onBusyChange={setUploading}
              autoFocus={autoFocusReply}
              minimumHeight={44}
            />
          ) : null}
        </>
      ) : null}
    </View>
  );
}

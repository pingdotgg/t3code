import { NativeStackScreenOptions } from "../../native/StackHeader";
import type {
  EnvironmentId,
  PullRequestReviewComment,
  PullRequestReviewSummary,
  PullRequestReviewThread,
} from "@t3tools/contracts";
import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import * as DateTime from "effect/DateTime";
import { SymbolView } from "expo-symbols";
import { useCallback, useMemo } from "react";
import { Pressable, RefreshControl, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text } from "../../components/AppText";
import { EmptyState } from "../../components/EmptyState";
import { ErrorBanner } from "../../components/ErrorBanner";
import { tryOpenExternalUrl } from "../../lib/openExternalUrl";
import { useThemeColor } from "../../lib/useThemeColor";
import { useEnvironmentQuery } from "../../state/query";
import { reviewEnvironment } from "../../state/review";
import { useThreadSelection } from "../../state/use-thread-selection";
import { useSelectedThreadWorktree } from "../../state/use-selected-thread-worktree";
import { vcsEnvironment } from "../../state/vcs";
import { MarkdownPreviewBody } from "../files/FileMarkdownPreview";

type PullRequestReviewScreenProps = StaticScreenProps<{
  readonly environmentId: string;
  readonly threadId: string;
}>;

const DATE_FORMATTER = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});

function commentDate(comment: PullRequestReviewComment): string {
  return DATE_FORMATTER.format(DateTime.toDate(comment.createdAt));
}

function AuthorLine(props: {
  readonly comment: PullRequestReviewComment;
  readonly suffix?: string;
}) {
  return (
    <View className="mb-2 flex-row flex-wrap items-center gap-2">
      <Text className="text-sm font-t3-bold text-foreground">@{props.comment.author.login}</Text>
      {props.comment.author.isBot ? (
        <Text className="rounded-full bg-violet-500/12 px-2 py-0.5 text-2xs font-t3-bold uppercase text-violet-600 dark:text-violet-300">
          Bot
        </Text>
      ) : null}
      {props.suffix ? (
        <Text className="text-xs font-t3-medium text-foreground-muted">{props.suffix}</Text>
      ) : null}
      <Text className="text-xs text-foreground-muted">{commentDate(props.comment)}</Text>
    </View>
  );
}

function CommentBody(props: {
  readonly comment: PullRequestReviewComment;
  readonly suffix?: string;
  readonly inset?: boolean;
}) {
  const linkColor = useThemeColor("--color-link");
  return (
    <View className={props.inset ? "border-l-2 border-border pl-3" : undefined}>
      <AuthorLine comment={props.comment} suffix={props.suffix} />
      <MarkdownPreviewBody markdown={props.comment.body || "_No comment body._"} />
      <Pressable
        className="mt-3 flex-row items-center gap-1.5 self-start"
        onPress={() => void tryOpenExternalUrl(props.comment.url, "pull-request")}
      >
        <Text className="text-xs font-t3-bold text-link">Open on GitHub</Text>
        <SymbolView name="arrow.up.right" size={11} tintColor={linkColor} />
      </Pressable>
    </View>
  );
}

function ReviewThreadCard(props: { readonly thread: PullRequestReviewThread }) {
  const thread = props.thread;
  const line = thread.line ?? thread.originalLine;
  const state = thread.isResolved ? "Resolved" : thread.isOutdated ? "Outdated" : "Unresolved";
  const tone = thread.isResolved
    ? "text-emerald-600 dark:text-emerald-300"
    : thread.isOutdated
      ? "text-foreground-muted"
      : "text-amber-700 dark:text-amber-300";
  return (
    <View className="rounded-[22px] border border-border bg-card p-4">
      <View className="mb-3 flex-row items-start gap-3">
        <SymbolView
          name={thread.isResolved ? "checkmark.circle.fill" : "text.bubble.fill"}
          size={17}
          tintColor={useThemeColor(thread.isResolved ? "--color-success" : "--color-icon")}
        />
        <View className="flex-1">
          <Text className="font-mono text-xs font-t3-bold text-foreground" numberOfLines={2}>
            {thread.path}
            {line ? `:${line}` : ""}
          </Text>
          <Text className={`mt-0.5 text-xs font-t3-bold ${tone}`}>{state}</Text>
        </View>
      </View>
      <View className="gap-4">
        {thread.comments.map((comment, index) => (
          <CommentBody key={comment.id} comment={comment} inset={index > 0} />
        ))}
      </View>
    </View>
  );
}

function ConversationCard(props: {
  readonly comment: PullRequestReviewComment | PullRequestReviewSummary;
}) {
  const state = "state" in props.comment ? props.comment.state.replaceAll("_", " ") : undefined;
  return (
    <View className="rounded-[22px] border border-border bg-card p-4">
      <CommentBody comment={props.comment} suffix={state} />
    </View>
  );
}

function SectionTitle(props: { readonly title: string; readonly count: number }) {
  return (
    <View className="flex-row items-baseline justify-between px-1">
      <Text className="text-base font-t3-bold text-foreground">{props.title}</Text>
      <Text className="text-xs font-t3-bold tabular-nums text-foreground-muted">{props.count}</Text>
    </View>
  );
}

export function PullRequestReviewScreen(props: PullRequestReviewScreenProps) {
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const primaryForeground = useThemeColor("--color-primary-foreground");
  const { selectedThread } = useThreadSelection();
  const { selectedThreadCwd } = useSelectedThreadWorktree();
  const selectionMatchesRoute =
    selectedThread !== null &&
    String(selectedThread.id) === props.route.params.threadId &&
    String(selectedThread.environmentId) === props.route.params.environmentId;
  const gitStatus = useEnvironmentQuery(
    selectionMatchesRoute && selectedThreadCwd
      ? vcsEnvironment.status({
          environmentId: props.route.params.environmentId as EnvironmentId,
          input: { cwd: selectedThreadCwd },
        })
      : null,
  );
  const pr = gitStatus.data?.pr ?? null;
  const review = useEnvironmentQuery(
    selectionMatchesRoute && selectedThreadCwd && pr
      ? reviewEnvironment.pullRequest({
          environmentId: props.route.params.environmentId as EnvironmentId,
          input: { cwd: selectedThreadCwd, reference: String(pr.number) },
        })
      : null,
  );
  const refresh = useCallback(() => {
    review.refresh();
    gitStatus.refresh();
  }, [gitStatus, review]);
  const unresolvedThreads = useMemo(
    () => review.data?.threads.filter((thread) => !thread.isResolved && !thread.isOutdated) ?? [],
    [review.data],
  );
  const otherThreads = useMemo(
    () => review.data?.threads.filter((thread) => thread.isResolved || thread.isOutdated) ?? [],
    [review.data],
  );
  const conversation = useMemo(
    () =>
      [...(review.data?.comments ?? []), ...(review.data?.reviews ?? [])].sort(
        (left, right) =>
          DateTime.toEpochMillis(left.createdAt) - DateTime.toEpochMillis(right.createdAt),
      ),
    [review.data],
  );
  const isEmpty = unresolvedThreads.length + otherThreads.length + conversation.length === 0;
  const reviewUrl = review.data?.url ?? null;

  return (
    <View className="flex-1 bg-sheet">
      <NativeStackScreenOptions
        options={{ title: pr ? `PR #${pr.number} comments` : "PR comments" }}
      />
      <ScrollView
        contentContainerStyle={{
          gap: 12,
          paddingHorizontal: 16,
          paddingTop: 14,
          paddingBottom: Math.max(insets.bottom, 18) + 24,
        }}
        refreshControl={<RefreshControl refreshing={review.isPending} onRefresh={refresh} />}
      >
        {review.error ? <ErrorBanner message={review.error} /> : null}
        {review.data?.truncated ? (
          <View className="rounded-2xl border border-amber-300 bg-amber-100/80 px-4 py-3 dark:border-amber-700 dark:bg-amber-950/50">
            <Text className="text-sm text-amber-800 dark:text-amber-200">
              GitHub has more comments than this snapshot contains. Open the PR for the complete
              discussion.
            </Text>
          </View>
        ) : null}
        {review.data ? (
          <View className="flex-row gap-2">
            <View className="flex-1 rounded-2xl bg-subtle px-3 py-3">
              <Text className="text-2xl font-t3-bold tabular-nums text-foreground">
                {review.data.unresolvedThreadCount}
              </Text>
              <Text className="text-xs text-foreground-muted">unresolved</Text>
            </View>
            <View className="flex-1 rounded-2xl bg-subtle px-3 py-3">
              <Text className="text-2xl font-t3-bold tabular-nums text-foreground">
                {review.data.threads.length + conversation.length}
              </Text>
              <Text className="text-xs text-foreground-muted">discussions</Text>
            </View>
          </View>
        ) : null}
        {review.isPending && !review.data ? (
          <View className="items-center py-12">
            <Text className="text-sm text-foreground-muted">Loading review comments…</Text>
          </View>
        ) : null}
        {review.data && isEmpty ? (
          <EmptyState
            title="No review comments"
            detail="No conversation comments, review summaries, or inline threads have been left on this pull request."
            variant="plain"
          />
        ) : null}
        {unresolvedThreads.length > 0 ? (
          <SectionTitle title="Unresolved threads" count={unresolvedThreads.length} />
        ) : null}
        {unresolvedThreads.map((thread) => (
          <ReviewThreadCard key={thread.id} thread={thread} />
        ))}
        {conversation.length > 0 ? (
          <SectionTitle title="Conversation & reviews" count={conversation.length} />
        ) : null}
        {conversation.map((comment) => (
          <ConversationCard key={comment.id} comment={comment} />
        ))}
        {otherThreads.length > 0 ? (
          <SectionTitle title="Resolved & outdated" count={otherThreads.length} />
        ) : null}
        {otherThreads.map((thread) => (
          <ReviewThreadCard key={thread.id} thread={thread} />
        ))}
        {reviewUrl ? (
          <Pressable
            className="mt-2 min-h-12 flex-row items-center justify-center gap-2 rounded-full bg-primary px-5"
            onPress={() => void tryOpenExternalUrl(reviewUrl, "pull-request")}
          >
            <Text className="font-t3-bold text-primary-foreground">Open pull request</Text>
            <SymbolView name="arrow.up.right" size={14} tintColor={primaryForeground} />
          </Pressable>
        ) : pr === null && !gitStatus.isPending ? (
          <EmptyState
            title="No pull request"
            detail="This branch does not currently have a pull request to review."
            actionLabel="Go back"
            onAction={() => navigation.goBack()}
            variant="plain"
          />
        ) : null}
      </ScrollView>
    </View>
  );
}

import {
  groupReviewTimelineConversations,
  pullRequestReviewVerdict,
  reviewParticipantsLabel,
  visibleCommentBody,
  type PullRequestReviewVerdict,
} from "@t3tools/client-runtime/review-threads";
import { PullRequestCommentItem, PullRequestThreadCard } from "./PullRequestCommentCard";
import { discussionCommentCountLabel } from "./pullRequestDiffComments";
import { PullRequestPendingBadge } from "./PullRequestPendingComment";
import { PullRequestEntryRow } from "./PullRequestEntryRow";
import { useAppearancePreferences } from "../settings/appearance/AppearancePreferencesProvider";
import IconGitCommit from "@tabler/icons-react-native/IconGitCommit";
import {
  pullRequestConversationThreads,
  type PullRequestActivity,
  type PullRequestComment,
} from "@t3tools/contracts";
import { StackActions, type NavigationProp } from "@react-navigation/native";
import { msg, T, useMessages, Var } from "gt-react-native";
import { useState, type ReactNode } from "react";
import { Pressable, View } from "react-native";
import { AppText as Text } from "../../components/ui/AppText";
import { SymbolView, type AppSymbolName } from "../../components/ui/AppSymbol";
import { byTimestamp, relativeTime } from "../../lib/time";
import { PullRequestAvatar } from "./PullRequestPresentation";
import type { PullRequestParams } from "./usePullRequestDiff";
import { m, type MessageResolver } from "../../i18n/messages";

function TimelineEvent(props: {
  icon: AppSymbolName | "commit";
  tone?: "success" | "danger";
  children: ReactNode;
}) {
  const { themeVariables: colors } = useAppearancePreferences();
  return (
    <PullRequestEntryRow
      leading={
        <>
          <View className="absolute top-0 bottom-0 w-px bg-border-subtle" />
          <View className="size-8 items-center justify-center rounded-full border border-border-subtle bg-grouped-card">
            {props.icon === "commit" ? (
              <View style={{ transform: [{ rotate: "90deg" }] }}>
                <IconGitCommit
                  size={17}
                  color={colors["--color-foreground-muted"] ?? "#838383"}
                  strokeWidth={1.8}
                />
              </View>
            ) : (
              <SymbolView
                name={props.icon}
                size={15}
                tintColorClassName={
                  props.tone === "success"
                    ? "accent-adaptive-emerald-600-400"
                    : props.tone === "danger"
                      ? "accent-danger-foreground"
                      : "accent-icon-muted"
                }
              />
            )}
          </View>
        </>
      }
    >
      <View className="gap-1.5 pt-1 pb-5">{props.children}</View>
    </PullRequestEntryRow>
  );
}

const VERDICT_PRESENTATION: Record<
  PullRequestReviewVerdict,
  { icon: AppSymbolName; tone?: "success" | "danger"; title: string }
> = {
  approved: { icon: "checkmark", tone: "success", title: msg("approved") },
  "changes-requested": { icon: "doc.text", tone: "danger", title: msg("requested changes") },
  dismissed: { icon: "xmark", title: msg("review dismissed") },
};

/** A top-level remark or review summary in the same dense card the review threads use. */
function TimelineComment({
  comment,
  params,
  verdict,
}: {
  comment: PullRequestComment;
  params: PullRequestParams;
  verdict?: PullRequestReviewVerdict | null;
}) {
  const messages = useMessages();
  return (
    <View className="overflow-hidden rounded-xl border border-border-subtle bg-grouped-card">
      <PullRequestCommentItem
        params={params}
        comment={{ ...comment, url: comment.url ?? null }}
        title={
          verdict
            ? messages(VERDICT_PRESENTATION[verdict].title)
            : comment.kind === "review"
              ? messages(msg("reviewed"))
              : messages(msg("commented"))
        }
        badges={comment.pendingReviewId ? <PullRequestPendingBadge /> : null}
        meta={
          comment.path ? (
            <Text className="font-mono text-2xs text-foreground-muted" numberOfLines={1}>
              {comment.path}
            </Text>
          ) : null
        }
      />
    </View>
  );
}

/**
 * Consecutive remarks between two commits or discussions read as one conversation, as on
 * desktop. A lone remark needs no section header; a longer run can be folded to its summary.
 */
function TimelineConversation({
  comments,
  params,
}: {
  comments: ReadonlyArray<PullRequestComment>;
  params: PullRequestParams;
}) {
  const messages = useMessages();
  const [open, setOpen] = useState(true);
  const first = comments[0];
  if (!first) return null;
  return (
    <TimelineEvent icon="bubble.left.and.bubble.right">
      {comments.length > 1 ? (
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ expanded: open }}
          onPress={() => setOpen(!open)}
          className="-mt-1 min-h-9 flex-row items-center gap-2 active:opacity-70"
        >
          <View className="min-w-0 flex-1">
            <Text className="text-xs font-t3-semibold">
              {discussionCommentCountLabel(comments.length, messages)}
            </Text>
            <Text className="text-2xs text-foreground-tertiary" numberOfLines={1}>
              {reviewParticipantsLabel(comments.map((comment) => comment.author))} ·{" "}
              {relativeTime(first.createdAt, undefined, messages)}
            </Text>
          </View>
          <SymbolView
            name={open ? "chevron.up" : "chevron.down"}
            size={11}
            tintColorClassName="accent-icon-muted"
          />
        </Pressable>
      ) : null}
      {open || comments.length === 1
        ? comments.map((comment) => (
            <TimelineComment key={comment.id} comment={comment} params={params} />
          ))
        : null}
    </TimelineEvent>
  );
}

export function pullRequestTimelineRows(
  activity: PullRequestActivity,
  params: PullRequestParams,
  navigation: Pick<NavigationProp<ReactNavigation.RootParamList>, "navigate" | "dispatch">,
  newestFirst: boolean,
  resolve: MessageResolver = m,
) {
  const threads = pullRequestConversationThreads(activity);
  const discussionIds = new Set(
    threads.flatMap((thread) => thread.comments.map((comment) => comment.id)),
  );
  type Entry = {
    key: string;
    date: string;
    content?: ReactNode;
    remark?: PullRequestComment;
  };
  const entries: Entry[] = [
    // A remark with nothing to read, typically the summary GitHub files for a batch of inline
    // comments, says nothing its discussions do not, so it is left out rather than drawn empty.
    ...activity.comments
      .filter((comment) => !discussionIds.has(comment.id))
      .flatMap((comment): Entry[] => {
        const verdict = pullRequestReviewVerdict(comment.reviewState);
        if (verdict === null && visibleCommentBody(comment.body) === null) return [];
        const key = `comment:${comment.id}`;
        if (verdict === null) return [{ key, date: comment.createdAt, remark: comment }];
        const presentation = VERDICT_PRESENTATION[verdict];
        return [
          {
            key,
            date: comment.createdAt,
            content: (
              <TimelineEvent icon={presentation.icon} tone={presentation.tone}>
                <TimelineComment comment={comment} params={params} verdict={verdict} />
              </TimelineEvent>
            ),
          },
        ];
      }),
    ...threads.map((thread) => ({
      key: `discussion:${thread.id}`,
      date: thread.comments.at(-1)?.createdAt ?? "",
      content: (
        <TimelineEvent icon="text.bubble" tone={thread.isResolved ? "success" : undefined}>
          {thread.path === null ? (
            <>
              <View className="flex-row items-center gap-2">
                <PullRequestAvatar actor={thread.comments[0]?.author ?? null} size={22} />
                <Text className="flex-1 text-sm">
                  <T>
                    <Text className="font-t3-medium">
                      <Var>
                        {thread.comments[0]?.author?.login ?? resolve(msg("Unknown author"))}
                      </Var>
                    </Text>
                    <Text className="text-foreground-muted"> started a discussion</Text>
                  </T>
                </Text>
                {thread.comments[0] ? (
                  <Text className="text-2xs text-foreground-tertiary">
                    {relativeTime(thread.comments[0].createdAt, undefined, resolve)}
                  </Text>
                ) : null}
              </View>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={
                  thread.isResolved
                    ? resolve(msg("Open resolved discussion in the overview"))
                    : resolve(msg("Open unresolved discussion in the overview"))
                }
                onPress={() =>
                  navigation.navigate("PullRequestDiscussion", {
                    ...params,
                    discussionId: thread.id,
                  })
                }
                className="gap-2 rounded-2xl bg-grouped-card p-3 active:opacity-70"
              >
                <Text className="text-xs">
                  <T>Overview</T>
                </Text>
                <Text className="text-xs text-foreground-muted">
                  {thread.isResolved
                    ? resolve(msg("Resolved", { $context: "review thread state" }))
                    : resolve(msg("Unresolved", { $context: "review thread state" }))}
                  {thread.isOutdated
                    ? ` · ${resolve(msg("Outdated", { $context: "review thread state" }))}`
                    : ""}{" "}
                  ·{" "}
                  {discussionCommentCountLabel(
                    thread.commentCount ?? thread.comments.length,
                    resolve,
                  )}
                </Text>
              </Pressable>
            </>
          ) : (
            <PullRequestThreadCard params={params} thread={thread} />
          )}
        </TimelineEvent>
      ),
    })),
    ...activity.commits.map((commit) => ({
      key: `commit:${commit.oid}`,
      date: commit.committedDate,
      content: (
        <TimelineEvent icon="commit">
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={resolve(
              msg("View commit {sha}, {headline}", {
                sha: commit.oid.slice(0, 7),
                headline: commit.messageHeadline,
              }),
            )}
            onPress={() =>
              navigation.dispatch(
                StackActions.push("PullRequestFile", { ...params, commit: commit.oid, path: "" }),
              )
            }
            className="flex-row items-center gap-2 active:opacity-70"
          >
            <PullRequestAvatar actor={commit.authors?.[0] ?? null} size={22} />
            <Text className="min-w-0 flex-1 text-sm" numberOfLines={1}>
              {commit.messageHeadline}
            </Text>
            <Text className="font-mono text-2xs text-foreground-muted">
              {commit.oid.slice(0, 7)}
            </Text>
          </Pressable>
        </TimelineEvent>
      ),
    })),
  ].sort(byTimestamp(false));
  const events = groupReviewTimelineConversations(
    entries,
    (entry) => entry.remark !== undefined,
  ).map(
    (row): { key: string; memberKeys?: readonly string[]; date: string; content: ReactNode } => {
      if (row.kind === "event")
        return { key: row.event.key, date: row.event.date, content: row.event.content };
      const remarks = row.events.flatMap((entry) => (entry.remark ? [entry.remark] : []));
      const first = row.events[0];
      return {
        key: `conversation:${first?.key ?? ""}`,
        memberKeys: row.events.map((entry) => entry.key),
        date: first?.date ?? "",
        content: (
          <TimelineConversation
            comments={newestFirst ? [...remarks].reverse() : remarks}
            params={params}
          />
        ),
      };
    },
  );
  if (newestFirst) events.reverse();
  if (activity.commentsTruncated || activity.reviewThreadsTruncated)
    events.push({
      key: "truncated",
      date: "",
      content: (
        <Text className="py-3 text-xs text-foreground-muted">
          <T>More activity is available on the provider.</T>
        </Text>
      ),
    });
  return events;
}

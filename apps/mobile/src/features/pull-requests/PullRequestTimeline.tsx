import {
  groupReviewTimelineConversations,
  pullRequestReviewVerdict,
  reviewParticipantsLabel,
  visibleCommentBody,
  type PullRequestReviewVerdict,
} from "@t3tools/client-runtime/review-threads";
import { PullRequestCommentItem, PullRequestThreadCard } from "./PullRequestCommentCard";
import { PullRequestPendingBadge } from "./PullRequestPendingComment";
import { PullRequestEntryRow } from "./PullRequestEntryRow";
import { useAppearancePreferences } from "../settings/appearance/AppearancePreferencesProvider";
import IconGitCommit from "@tabler/icons-react-native/IconGitCommit";
import type { PullRequestActivity, PullRequestComment } from "@t3tools/contracts";
import { StackActions, type NavigationProp } from "@react-navigation/native";
import { useMemo, useState, type ReactNode } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { parseMarkdownDocument } from "../../lib/markdownDocument";
import { AppText as Text } from "../../components/ui/AppText";
import { SymbolView, type AppSymbolName } from "../../components/ui/AppSymbol";
import { relativeTime } from "../../lib/time";
import { PullRequestAvatar } from "./PullRequestPresentation";
import type { PullRequestParams } from "./usePullRequestDiff";

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
  approved: { icon: "checkmark", tone: "success", title: "approved" },
  "changes-requested": { icon: "doc.text", tone: "danger", title: "requested changes" },
  dismissed: { icon: "xmark", title: "review dismissed" },
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
  return (
    <View className="overflow-hidden rounded-xl border border-border-subtle bg-grouped-card">
      <PullRequestCommentItem
        params={params}
        comment={{ ...comment, url: comment.url ?? null }}
        title={
          verdict
            ? VERDICT_PRESENTATION[verdict].title
            : comment.kind === "review"
              ? "reviewed"
              : "commented"
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
            <Text className="text-xs font-t3-semibold">{comments.length} comments</Text>
            <Text className="text-2xs text-foreground-tertiary" numberOfLines={1}>
              {reviewParticipantsLabel(comments.map((comment) => comment.author))} ·{" "}
              {relativeTime(first.createdAt)}
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
  newestFirst = false,
) {
  const discussionIds = new Set(
    activity.reviewThreads.flatMap((thread) => thread.comments.map((comment) => comment.id)),
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
    ...activity.reviewThreads.map((thread) => ({
      key: `discussion:${thread.id}`,
      date: thread.comments.at(-1)?.createdAt ?? "",
      content: (
        <TimelineEvent icon="text.bubble" tone={thread.isResolved ? "success" : undefined}>
          <PullRequestThreadCard params={params} thread={thread} />
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
            accessibilityLabel={`View commit ${commit.oid.slice(0, 7)}, ${commit.messageHeadline}`}
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
  ].sort((a, b) => (Date.parse(a.date) || 0) - (Date.parse(b.date) || 0));
  const events = groupReviewTimelineConversations(
    entries,
    (entry) => entry.remark !== undefined,
  ).map((row): { key: string; date: string; content: ReactNode } => {
    if (row.kind === "event")
      return { key: row.event.key, date: row.event.date, content: row.event.content };
    const remarks = row.events.flatMap((entry) => (entry.remark ? [entry.remark] : []));
    const first = row.events[0];
    return {
      key: `conversation:${first?.key ?? ""}`,
      date: first?.date ?? "",
      content: (
        <TimelineConversation
          comments={
            // eslint-disable-next-line unicorn/no-array-reverse -- Hermes lacks toReversed; reverse a fresh array.
            newestFirst ? [...remarks].reverse() : remarks
          }
          params={params}
        />
      ),
    };
  });
  if (activity.commentsTruncated || activity.reviewThreadsTruncated)
    events.push({
      key: "truncated",
      date: "",
      content: (
        <Text className="py-3 text-xs text-foreground-muted">
          More activity is available on the provider.
        </Text>
      ),
    });
  return events;
}

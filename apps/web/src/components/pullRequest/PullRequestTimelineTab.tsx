import type {
  PullRequestActivity,
  PullRequestComment,
  PullRequestCommit,
  PullRequestDetail,
} from "@t3tools/contracts";
import {
  ArrowDownUpIcon,
  ChevronDownIcon,
  GitCommitHorizontalIcon,
  GitMergeIcon,
  GitPullRequestClosedIcon,
  GitPullRequestIcon,
  MessageSquareIcon,
} from "lucide-react";
import { useMemo, useState } from "react";

import { Button } from "../ui/button";
import { formatRelativeTimeLabel } from "~/timestampFormat";
import { PullRequestActorAvatar, PullRequestDiffStat } from "./pullRequestPresentation";
import { PullRequestCommentCard } from "./PullRequestSummaryTab";
import type { PullRequestMediaPreview } from "./PullRequestMediaDialog";

type Detail = PullRequestDetail & PullRequestActivity;
type TimelineEntry =
  | { kind: "comment"; date: string; comment: PullRequestComment }
  | { kind: "commit"; date: string; commit: PullRequestCommit }
  | { kind: "opened" | "closed" | "merged"; date: string };
type TimelineRow =
  | Exclude<TimelineEntry, { kind: "comment" }>
  | { kind: "comments"; comments: PullRequestComment[] };

export function PullRequestTimelineTab({
  detail,
  pending,
  error,
  onRetry,
  onOpenCommit,
  onPreviewMedia,
}: {
  readonly detail: Detail;
  readonly pending: boolean;
  readonly error: string | null;
  readonly onRetry: () => void;
  readonly onOpenCommit: (commit: string) => void;
  readonly onPreviewMedia: (preview: PullRequestMediaPreview) => void;
}) {
  const [newestFirst, setNewestFirst] = useState(true);
  const [expandedGroups, setExpandedGroups] = useState<ReadonlySet<string>>(() => new Set());
  const rows = useMemo(() => {
    const entries: TimelineEntry[] = [
      { kind: "opened", date: detail.createdAt },
      ...detail.commits.map((commit) => ({
        kind: "commit" as const,
        date: commit.committedDate,
        commit,
      })),
      ...detail.comments.map((comment) => ({
        kind: "comment" as const,
        date: comment.createdAt,
        comment,
      })),
    ];
    if (detail.mergedAt) entries.push({ kind: "merged", date: detail.mergedAt });
    else if (detail.closedAt) entries.push({ kind: "closed", date: detail.closedAt });
    entries.sort((a, b) => a.date.localeCompare(b.date));
    const grouped: TimelineRow[] = [];
    for (const entry of entries) {
      if (entry.kind !== "comment") {
        grouped.push(entry);
        continue;
      }
      const last = grouped.at(-1);
      if (last?.kind === "comments") last.comments.push(entry.comment);
      else grouped.push({ kind: "comments", comments: [entry.comment] });
    }
    return grouped;
  }, [detail.createdAt, detail.closedAt, detail.mergedAt, detail.comments, detail.commits]);
  const threadByComment = useMemo(
    () =>
      new Map(
        detail.reviewThreads.flatMap((thread) =>
          thread.comments.map((comment) => [comment.id, thread] as const),
        ),
      ),
    [detail.reviewThreads],
  );
  const orderedRows = newestFirst ? rows.toReversed() : rows;

  return (
    <div className="px-6 py-4">
      <div className="mb-4 flex justify-end">
        <Button
          aria-label={newestFirst ? "Show oldest activity first" : "Show newest activity first"}
          className="text-muted-foreground"
          size="xs"
          variant="ghost"
          onClick={() => setNewestFirst(!newestFirst)}
        >
          <ArrowDownUpIcon className="size-3" />
          {newestFirst ? "Newest first" : "Oldest first"}
        </Button>
      </div>
      {pending ? <p className="mb-4 text-xs text-muted-foreground">Loading timeline…</p> : null}
      {error ? (
        <div role="alert" className="mb-4 flex items-center gap-3 text-sm text-destructive">
          <span className="min-w-0 flex-1">Could not load the full timeline: {error}</span>
          <Button size="xs" variant="outline" onClick={onRetry}>
            Retry
          </Button>
        </div>
      ) : null}
      <ol className="relative space-y-8 before:absolute before:top-3 before:bottom-3 before:left-3 before:w-px before:bg-border/60">
        {orderedRows.map((row) => {
          if (row.kind === "comments") {
            const comments = newestFirst ? row.comments.toReversed() : row.comments;
            const first = comments[0];
            const groupId = row.comments[0]?.id;
            if (!first || !groupId) return null;
            const authors = new Set(comments.map((comment) => comment.author?.login ?? "ghost"));
            return (
              <li className="relative flex gap-5" key={`comments:${row.comments[0]?.id}`}>
                <span className="relative z-10 flex size-6 shrink-0 items-center justify-center rounded-full bg-chat-background">
                  {first.author ? (
                    <PullRequestActorAvatar actor={first.author} className="size-6" />
                  ) : (
                    <MessageSquareIcon className="size-4 text-muted-foreground" />
                  )}
                </span>
                <details
                  className="group min-w-0 flex-1"
                  onToggle={(event) => {
                    const open = event.currentTarget.open;
                    setExpandedGroups((current) => {
                      if (current.has(groupId) === open) return current;
                      const next = new Set(current);
                      if (open) next.add(groupId);
                      else next.delete(groupId);
                      return next;
                    });
                  }}
                >
                  <summary
                    role="button"
                    aria-label={`${comments.length} ${comments.length === 1 ? "comment" : "comments"}`}
                    className="flex cursor-pointer list-none items-center gap-3 rounded-sm focus-visible:outline-2 focus-visible:outline-ring"
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block text-sm font-medium">
                        {comments.length} {comments.length === 1 ? "comment" : "comments"}
                      </span>
                      <span className="text-xs text-muted-foreground">
                        {authors.size} {authors.size === 1 ? "author" : "authors"} ·{" "}
                        {formatRelativeTimeLabel(first.createdAt)}
                      </span>
                    </span>
                    <ChevronDownIcon className="size-4 text-muted-foreground transition-transform group-open:rotate-180" />
                  </summary>
                  {expandedGroups.has(groupId) ? (
                    <div className="mt-4 space-y-3">
                      {comments.map((comment) => (
                        <PullRequestCommentCard
                          key={comment.id}
                          comment={comment}
                          detail={detail}
                          thread={threadByComment.get(comment.id)}
                          onPreview={onPreviewMedia}
                        />
                      ))}
                    </div>
                  ) : null}
                </details>
              </li>
            );
          }
          if (row.kind === "commit") {
            const { commit } = row;
            return (
              <li className="relative flex items-start gap-5" key={`commit:${commit.oid}`}>
                <span className="relative z-10 flex size-6 shrink-0 items-center justify-center rounded-full bg-chat-background">
                  {commit.authors?.[0] ? (
                    <PullRequestActorAvatar actor={commit.authors[0]} className="size-6" />
                  ) : (
                    <GitCommitHorizontalIcon className="size-4 text-muted-foreground" />
                  )}
                </span>
                <button
                  aria-label={`View commit ${commit.oid.slice(0, 7)}`}
                  className="min-w-0 flex-1 rounded-sm text-left hover:text-primary focus-visible:outline-2 focus-visible:outline-ring disabled:cursor-default disabled:hover:text-foreground"
                  disabled={!detail.capabilities.diff}
                  type="button"
                  onClick={() => onOpenCommit(commit.oid)}
                >
                  <span className="block text-sm font-medium wrap-anywhere">
                    {commit.messageHeadline}
                  </span>
                  <span className="mt-1 block text-xs text-muted-foreground">
                    <span className="font-mono">{commit.oid.slice(0, 7)}</span> ·{" "}
                    {formatRelativeTimeLabel(commit.committedDate)}
                  </span>
                </button>
                {commit.additions !== undefined && commit.deletions !== undefined ? (
                  <PullRequestDiffStat
                    additions={commit.additions}
                    deletions={commit.deletions}
                    className="shrink-0 font-mono text-xs"
                  />
                ) : null}
              </li>
            );
          }
          const Icon =
            row.kind === "merged"
              ? GitMergeIcon
              : row.kind === "closed"
                ? GitPullRequestClosedIcon
                : GitPullRequestIcon;
          return (
            <li className="relative flex items-start gap-5" key={`${row.kind}:${row.date}`}>
              <span className="relative z-10 flex size-6 shrink-0 items-center justify-center bg-chat-background text-muted-foreground">
                <Icon className="size-4" />
              </span>
              <div>
                <p className="text-sm font-medium">
                  {row.kind === "opened" && detail.author ? (
                    <span>{detail.author.login} </span>
                  ) : null}
                  <span>Pull request {row.kind}</span>
                </p>
                <p className="mt-1 text-xs text-muted-foreground">
                  {formatRelativeTimeLabel(row.date)}
                </p>
              </div>
            </li>
          );
        })}
      </ol>
      {detail.commentsTruncated ? (
        <p className="mt-6 text-xs text-muted-foreground">
          Showing {detail.comments.length} of at least {detail.commentCount} conversation items.
          Some review comments are unavailable.
        </p>
      ) : null}
    </div>
  );
}

import type {
  PullRequestActivity,
  PullRequestComment,
  PullRequestDetail,
  PullRequestReviewThread,
} from "@t3tools/contracts";
import { ArrowDownUpIcon, ChevronRightIcon } from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";

import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";
import { cn } from "~/lib/utils";
import { formatRelativeTimeLabel } from "~/timestampFormat";
import { PullRequestBody } from "./PullRequestBody";
import type { PullRequestMediaPreview } from "./PullRequestMediaDialog";
import {
  PullRequestActorLabel,
  PullRequestCheckStatusIcon,
  pullRequestCheckStatusLabel,
  pullRequestReviewVerdictPresentation,
} from "./pullRequestPresentation";

type PullRequestDetailView = PullRequestDetail & PullRequestActivity;

/**
 * Which review states are a verdict. Copied from upstream's
 * `pullRequestDetail.logic.ts`: hosts spell the same three differently, so
 * case and separator are ignored, and anything else is not a verdict.
 */
function pullRequestReviewOutcome(
  reviewState: string | null,
): "approved" | "changes-requested" | "dismissed" | null {
  switch (reviewState?.trim().toLowerCase().replaceAll("_", "-")) {
    case "approved":
      return "approved";
    case "changes-requested":
      return "changes-requested";
    case "dismissed":
      return "dismissed";
    default:
      return null;
  }
}

function orderComments<T extends { readonly createdAt: string }>(
  comments: ReadonlyArray<T>,
  order: "newest" | "oldest",
): ReadonlyArray<T> {
  return order === "newest" ? comments.toReversed() : comments;
}

/** HTML-comment-only bodies render as empty cards, so they count as no body. */
function visibleBody(body: string): string | null {
  return body.replace(/<!--[\s\S]*?-->/gu, "").trim().length === 0 ? null : body.trim();
}

function ReviewVerdictBadge({ reviewState }: { readonly reviewState: string | null }) {
  const presentation = pullRequestReviewVerdictPresentation(reviewState);
  if (presentation.variant === null) {
    return (
      <span className="rounded bg-accent px-1 py-px font-medium text-foreground">
        {presentation.label}
      </span>
    );
  }
  return (
    <Badge size="sm" variant={presentation.variant}>
      {presentation.label}
    </Badge>
  );
}

function Section({
  title,
  defaultOpen = true,
  actions,
  children,
}: {
  readonly title: string;
  readonly defaultOpen?: boolean;
  readonly actions?: ReactNode;
  readonly children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section aria-label={title}>
      <Collapsible open={open} onOpenChange={setOpen}>
        <div className="sticky top-0 z-10 flex w-full items-center bg-chat-background pr-4">
          <CollapsibleTrigger className="flex min-w-0 flex-1 items-center gap-1.5 px-4 py-3 text-left text-xs font-medium text-muted-foreground hover:text-foreground">
            <span>{title}</span>
            <ChevronRightIcon
              aria-hidden
              className={cn(
                "size-3.5 text-muted-foreground/60 transition-transform",
                open && "rotate-90",
              )}
            />
          </CollapsibleTrigger>
          {actions}
        </div>
        <CollapsiblePanel>
          <div className="px-4 pb-4">{children}</div>
        </CollapsiblePanel>
      </Collapsible>
    </section>
  );
}

function CommentCard({
  comment,
  detail,
  thread,
  onPreview,
}: {
  readonly comment: PullRequestComment;
  readonly detail: PullRequestDetailView;
  readonly thread: PullRequestReviewThread | undefined;
  readonly onPreview: (preview: PullRequestMediaPreview) => void;
}) {
  const body = visibleBody(comment.body);
  const outcome = pullRequestReviewOutcome(comment.reviewState);
  return (
    <article className="rounded-xl border border-border/60 bg-background [contain-intrinsic-block-size:160px] [content-visibility:auto]">
      <div className="flex min-w-0 items-center gap-2 px-3 pt-2.5 text-xs">
        <PullRequestActorLabel
          actor={comment.author}
          className="min-w-0 font-medium text-foreground"
        />
        {outcome !== null || comment.reviewState ? (
          <ReviewVerdictBadge reviewState={comment.reviewState} />
        ) : null}
        <span className="ml-auto shrink-0 text-muted-foreground">
          {formatRelativeTimeLabel(comment.createdAt)}
        </span>
      </div>
      {(thread?.path ?? comment.path) ? (
        <div className="truncate px-3 pt-1.5 font-mono text-[10px] text-muted-foreground">
          {thread?.path ?? comment.path}
          {thread?.line ? `:${thread.line}` : ""}
          {thread?.isOutdated ? " · outdated" : ""}
        </div>
      ) : null}
      {body === null ? null : (
        <div className="px-3 pt-1.5 pb-3 text-sm">
          <PullRequestBody body={comment.body} cwd={detail.workspaceRoot} onPreview={onPreview} />
        </div>
      )}
    </article>
  );
}

function FinishedCommentRow({
  comment,
  detail,
  thread,
  onPreview,
}: {
  readonly comment: PullRequestComment;
  readonly detail: PullRequestDetailView;
  readonly thread: PullRequestReviewThread | undefined;
  readonly onPreview: (preview: PullRequestMediaPreview) => void;
}) {
  const [open, setOpen] = useState(false);
  const body = visibleBody(comment.body);
  const label = thread?.isResolved ? "Resolved" : "Review dismissed";
  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <div className="overflow-hidden rounded-xl border border-border/60 bg-background [contain-intrinsic-block-size:44px] [content-visibility:auto]">
        <CollapsibleTrigger
          aria-label={`${comment.author?.login ?? "ghost"} ${label}`}
          className="flex w-full items-center gap-2 px-3 py-2.5 text-left"
        >
          <PullRequestActorLabel actor={comment.author} className="min-w-0 text-xs" />
          <span className="shrink-0 text-xs text-muted-foreground">{label}</span>
          <span className="ml-auto shrink-0 text-xs text-muted-foreground">
            {formatRelativeTimeLabel(comment.createdAt)}
          </span>
          <ChevronRightIcon
            aria-hidden
            className={cn(
              "size-3.5 shrink-0 text-muted-foreground transition-transform",
              open && "rotate-90",
            )}
          />
        </CollapsibleTrigger>
        <CollapsiblePanel>
          {open && body !== null ? (
            <div className="border-t border-border/60 px-3 py-3 text-sm">
              <PullRequestBody
                body={comment.body}
                cwd={detail.workspaceRoot}
                onPreview={onPreview}
              />
            </div>
          ) : null}
        </CollapsiblePanel>
      </div>
    </Collapsible>
  );
}

const COMMENT_PAGE = 10;

export function PullRequestSummaryTab({
  detail,
  activityPending,
  activityError,
  onRetryActivity,
  onPreviewMedia,
  onOpenUrl,
}: {
  readonly detail: PullRequestDetailView;
  readonly activityPending: boolean;
  readonly activityError: string | null;
  readonly onRetryActivity: () => void;
  readonly onPreviewMedia: (preview: PullRequestMediaPreview) => void;
  readonly onOpenUrl: (url: string) => void;
}) {
  const [commentOrder, setCommentOrder] = useState<"newest" | "oldest">("newest");
  const [shown, setShown] = useState({ url: detail.url, count: COMMENT_PAGE });
  const shownComments = shown.url === detail.url ? shown.count : COMMENT_PAGE;

  const threadByCommentId = useMemo(
    () =>
      new Map(
        detail.reviewThreads.flatMap((thread) =>
          thread.comments.map((comment) => [comment.id, thread] as const),
        ),
      ),
    [detail.reviewThreads],
  );

  // A remark already on a review thread belongs to that thread; a resolved one
  // is finished work. Local contracts carry no bot flag, so every unfinished
  // remark stays in the main list (upstream splits bots out separately).
  const activeComments: PullRequestComment[] = [];
  const finishedComments: PullRequestComment[] = [];
  for (const comment of detail.comments) {
    const finished =
      threadByCommentId.get(comment.id)?.isResolved === true ||
      pullRequestReviewOutcome(comment.reviewState) === "dismissed";
    (finished ? finishedComments : activeComments).push(comment);
  }
  const recentComments = activeComments.slice(Math.max(0, activeComments.length - shownComments));
  const hiddenCommentCount = activeComments.length - recentComments.length;
  const visibleComments = useMemo(
    () => orderComments(recentComments, commentOrder),
    [recentComments, commentOrder],
  );

  return (
    <div className="h-full overflow-y-auto" data-pull-request-summary-scroll>
      <Section key={`description:${detail.url}`} title="Description">
        <PullRequestBody
          body={detail.body.trim().length > 0 ? detail.body : "_No description provided._"}
          cwd={detail.workspaceRoot}
          onPreview={onPreviewMedia}
        />
      </Section>

      <Section
        key={`checks:${detail.url}`}
        title={`Checks (${detail.checks.length})`}
        defaultOpen={false}
      >
        {detail.checks.length === 0 ? (
          <p className="text-xs text-muted-foreground">No checks reported.</p>
        ) : (
          <ul className="space-y-1">
            {detail.checks.map((check, index) => (
              // Keyed by position as well as by name: the host decides how many
              // runs share a name, and a repeated key would be a rendering fault.
              <li key={`${index}:${check.name}`}>
                <button
                  className={cn(
                    "flex min-w-0 flex-1 items-start gap-2 rounded-md px-2 py-2 text-left text-xs leading-5 [&>svg]:mt-0.5",
                    check.url ? "cursor-pointer hover:bg-accent/60" : "cursor-default",
                  )}
                  disabled={!check.url}
                  type="button"
                  onClick={() => check.url && onOpenUrl(check.url)}
                >
                  <PullRequestCheckStatusIcon status={check.status} />
                  <span className="min-w-0 flex-1 wrap-anywhere">{check.name}</span>
                  <span className="shrink-0 text-muted-foreground">
                    {pullRequestCheckStatusLabel(check.status)}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section
        key={`comments:${detail.url}`}
        title={`Comments (${detail.commentCount})`}
        actions={
          <Button
            aria-label={
              commentOrder === "newest"
                ? "Show oldest comments first"
                : "Show newest comments first"
            }
            className="shrink-0"
            size="xs"
            variant="ghost"
            onClick={() => setCommentOrder((value) => (value === "newest" ? "oldest" : "newest"))}
          >
            <ArrowDownUpIcon aria-hidden className="size-3" />
            {commentOrder === "newest" ? "Newest first" : "Oldest first"}
          </Button>
        }
      >
        {activityPending ? (
          <p className="py-2 text-xs text-muted-foreground">Loading comments…</p>
        ) : activityError ? (
          <div className="flex items-center gap-3 rounded-lg border border-destructive/40 p-3 text-sm text-destructive">
            <span className="min-w-0 flex-1">Could not load comments: {activityError}</span>
            <Button size="xs" variant="outline" onClick={onRetryActivity}>
              Retry
            </Button>
          </div>
        ) : detail.comments.length === 0 && finishedComments.length === 0 ? (
          <p className="py-2 text-xs text-muted-foreground">No comments yet.</p>
        ) : (
          <div className="space-y-3">
            {detail.commentsTruncated ? (
              <p className="rounded-md border border-amber-500/30 bg-amber-500/5 px-2 py-1.5 text-xs text-muted-foreground">
                GitHub returned the most recent {detail.comments.length} of {detail.commentCount}{" "}
                items; some line-level review comments may be missing.
              </p>
            ) : null}
            {commentOrder === "oldest" && hiddenCommentCount > 0 ? (
              <Button
                className="w-full"
                size="sm"
                variant="outline"
                onClick={() => setShown({ url: detail.url, count: shownComments + COMMENT_PAGE })}
              >
                Show {Math.min(hiddenCommentCount, COMMENT_PAGE)} older comment
                {hiddenCommentCount === 1 ? "" : "s"} ({hiddenCommentCount} hidden)
              </Button>
            ) : null}
            {visibleComments.map((comment) => (
              <CommentCard
                comment={comment}
                detail={detail}
                key={`${detail.url}:${comment.id}`}
                thread={threadByCommentId.get(comment.id)}
                onPreview={onPreviewMedia}
              />
            ))}
            {commentOrder === "newest" && hiddenCommentCount > 0 ? (
              <Button
                className="w-full"
                size="sm"
                variant="outline"
                onClick={() => setShown({ url: detail.url, count: shownComments + COMMENT_PAGE })}
              >
                Show {Math.min(hiddenCommentCount, COMMENT_PAGE)} older comment
                {hiddenCommentCount === 1 ? "" : "s"} ({hiddenCommentCount} hidden)
              </Button>
            ) : null}
            {shownComments > COMMENT_PAGE ? (
              <Button
                className="w-full"
                size="sm"
                variant="ghost"
                onClick={() => setShown({ url: detail.url, count: COMMENT_PAGE })}
              >
                Show only {COMMENT_PAGE} recent comments
              </Button>
            ) : null}
            {orderComments(finishedComments, commentOrder).map((comment) => (
              <FinishedCommentRow
                comment={comment}
                detail={detail}
                key={comment.id}
                thread={threadByCommentId.get(comment.id)}
                onPreview={onPreviewMedia}
              />
            ))}
          </div>
        )}
      </Section>
    </div>
  );
}

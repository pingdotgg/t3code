import {
  capitalizeTerm,
  sourceControlClients,
} from "@t3tools/client-runtime/source-control-clients";
import type { EnvironmentId, PullRequestDetailView, PullRequestRef } from "@t3tools/contracts";
import { ChevronDownIcon, MessageSquarePlusIcon, Trash2Icon } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { flushSync } from "react-dom";

import { cn } from "~/lib/utils";
import { Button } from "../ui/button";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import { PullRequestCommentForm } from "./PullRequestCommentForm";
import { PullRequestReviewForm } from "./PullRequestReviewForm";
import {
  pullRequestReviewKey,
  usePendingReviewComments,
  usePullRequestReviewStore,
} from "./pullRequestReviewStore";
import { pullRequestCompletionScope } from "./PullRequestMarkdownTextarea";

export function PullRequestComposer({
  environmentId,
  reference,
  detail,
  actionPending,
  onCommentAction,
  onCommented,
  onReviewSubmitted,
  openReviewRequest,
  compact,
}: {
  environmentId: EnvironmentId;
  reference: PullRequestRef;
  detail: PullRequestDetailView;
  actionPending: boolean;
  onCommentAction: (
    body: string,
    action: "close" | "reopen",
  ) => Promise<{ readonly commentPosted: boolean }>;
  onCommented: () => void;
  onReviewSubmitted: () => void;
  openReviewRequest?: number | undefined;
  /** A pill in the corner instead of the bar, where a bar would cover a diff. */
  compact: boolean;
}) {
  const term = sourceControlClients.get(detail.provider).changeRequest.singular;
  const [open, setOpen] = useState(false);
  const composerId = useId();
  const [reviewPending, setReviewPending] = useState(false);
  const [requestedMode, setRequestedMode] = useState<"comment" | "review">("comment");
  const rootRef = useRef<HTMLDivElement>(null);
  const barRef = useRef<HTMLButtonElement>(null);
  const commentRef = useRef<HTMLTextAreaElement>(null);
  const reviewRef = useRef<HTMLTextAreaElement>(null);
  const pendingComments = usePendingReviewComments(reference);
  const clearComments = usePullRequestReviewStore((store) => store.clear);
  // Unsent summaries outlive the composer; select a boolean to avoid per-keystroke renders.
  const reviewKey = pullRequestReviewKey(reference);
  const summaryStarted = usePullRequestReviewStore(
    (store) => (store.summaries[reviewKey] ?? "").trim().length > 0,
  );
  const reviewStarted = pendingComments.length > 0 || summaryStarted;
  const [answeredOpenRequest, setAnsweredOpenRequest] = useState(openReviewRequest);
  if (openReviewRequest !== answeredOpenRequest) {
    setAnsweredOpenRequest(openReviewRequest);
    setRequestedMode("review");
    setOpen(true);
  }

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- moves DOM focus when a line comment asks to open the review
  useEffect(() => {
    if (answeredOpenRequest !== undefined) reviewRef.current?.focus();
  }, [answeredOpenRequest]);

  const canComment = detail.capabilities.comment && detail.viewerPermissions.comment;
  const verdicts = detail.capabilities.review.verdicts.filter((verdict) =>
    detail.viewerPermissions.verdicts.includes(verdict),
  );
  if (!canComment && verdicts.length === 0) return null;

  const mode = canComment ? (verdicts.length === 0 ? "comment" : requestedMode) : "review";
  const reviewing = reviewStarted || !canComment;

  const focusMode = (next: "comment" | "review") =>
    (next === "review" ? reviewRef : commentRef).current?.focus();
  const expand = () => {
    const next = reviewStarted ? "review" : "comment";
    flushSync(() => {
      setRequestedMode(next);
      setOpen(true);
    });
    focusMode(canComment ? (verdicts.length === 0 ? "comment" : next) : "review");
  };

  const collapse = () => {
    // A slow submission can finish after the user has moved on; a locked field leaves focus on body.
    const focused = document.activeElement;
    const movedElsewhere =
      focused !== null && focused !== document.body && !rootRef.current?.contains(focused);
    flushSync(() => setOpen(false));
    if (!movedElsewhere) barRef.current?.focus();
  };

  return (
    <div
      ref={rootRef}
      className={cn("flex flex-col items-end", !compact && "items-stretch")}
      onKeyDown={(event) => {
        if (event.key !== "Escape" || !open || event.defaultPrevented) return;
        event.preventDefault();
        collapse();
      }}
    >
      <button
        ref={barRef}
        type="button"
        hidden={open}
        className={cn(
          "dropdown-glass dark:ring-1 dark:ring-inset dark:ring-border flex h-10 cursor-pointer items-center gap-2 rounded-2xl px-3.5 text-sm text-placeholder shadow-lg outline-none transition-colors hover:text-muted-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
          compact ? "w-auto" : "w-full",
        )}
        aria-expanded={open}
        aria-controls={composerId}
        aria-label={
          pendingComments.length > 0
            ? `Review ${term}, ${pendingComments.length} ${pendingComments.length === 1 ? "comment" : "comments"} pending`
            : reviewing
              ? `Review ${term}`
              : `Comment on ${term}`
        }
        onClick={expand}
      >
        <MessageSquarePlusIcon aria-hidden className="size-4 shrink-0" />
        <span className="truncate">
          {compact
            ? reviewing
              ? "Review"
              : "Comment"
            : reviewing
              ? `Review this ${term}`
              : `Comment on this ${term}`}
        </span>
        {pendingComments.length > 0 ? (
          <span
            aria-hidden
            className="ml-auto flex h-4 min-w-4 items-center justify-center rounded-full bg-info px-1 text-3xs font-semibold tabular-nums text-white"
          >
            {pendingComments.length}
          </span>
        ) : null}
      </button>
      {/* Kept mounted while collapsed so drafts and submit guards survive. */}
      <section
        id={composerId}
        hidden={!open}
        aria-label={`${capitalizeTerm(term)} composer`}
        className={cn(
          "dropdown-glass dark:ring-1 dark:ring-inset dark:ring-border rounded-2xl px-1.5 pt-2 pb-2.5 shadow-xl",
          compact ? "w-96 max-w-[calc(100vw-2rem)]" : "w-full",
        )}
      >
        <div className="mb-1 flex items-center justify-between gap-2 px-1.5">
          {canComment && verdicts.length > 0 ? (
            <ToggleGroup
              aria-label="Composer mode"
              variant="segmented"
              value={[mode]}
              onValueChange={(next) => {
                const value = next[0];
                if (value !== "comment" && value !== "review") return;
                flushSync(() => setRequestedMode(value));
                focusMode(value);
              }}
            >
              <Toggle value="comment">Comment</Toggle>
              <Toggle value="review">
                {pendingComments.length > 0 ? `Review (${pendingComments.length})` : "Review"}
              </Toggle>
            </ToggleGroup>
          ) : (
            <h2 className="px-1 text-sm font-medium">
              {mode === "review" ? `Review ${term}` : `Comment on ${term}`}
            </h2>
          )}
          <div className="flex items-center gap-1">
            {mode === "review" && pendingComments.length > 0 ? (
              <Button
                size="icon-xs"
                variant="ghost"
                aria-label="Discard pending line comments"
                title="Discard pending line comments"
                disabled={reviewPending}
                onClick={() => clearComments(reviewKey)}
              >
                <Trash2Icon className="size-3.5" />
              </Button>
            ) : null}
            <Button
              size="icon-xs"
              variant="ghost"
              aria-label="Collapse composer"
              title="Collapse (Esc)"
              onClick={collapse}
            >
              <ChevronDownIcon className="size-4" />
            </Button>
          </div>
        </div>
        {verdicts.length > 0 ? (
          <div hidden={mode !== "review"}>
            <PullRequestReviewForm
              active={open && mode === "review"}
              environmentId={environmentId}
              reference={reference}
              completionScope={pullRequestCompletionScope(detail, environmentId, reference)}
              term={term}
              verdicts={verdicts}
              requestChangesSummaryRequired={sourceControlClients
                .get(detail.provider)
                .reviewSummaryRequired("request-changes")}
              textareaRef={reviewRef}
              pending={reviewPending}
              onPendingChange={setReviewPending}
              onSubmitted={() => {
                collapse();
                onReviewSubmitted();
              }}
            />
          </div>
        ) : null}
        {canComment ? (
          <div hidden={mode !== "comment"}>
            <PullRequestCommentForm
              active={open && mode === "comment"}
              environmentId={environmentId}
              reference={reference}
              detail={detail}
              actionPending={actionPending}
              textareaRef={commentRef}
              onCommentAction={onCommentAction}
              onCommented={onCommented}
              onClose={collapse}
            />
          </div>
        ) : null}
      </section>
    </div>
  );
}

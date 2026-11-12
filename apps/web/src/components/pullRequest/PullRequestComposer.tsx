import { pendingReviewIdentityFromThreads } from "@t3tools/client-runtime/review-editing";
import { usePullRequestReviewScope } from "./usePullRequestReviewKey";
import {
  capitalizeTerm,
  sourceControlClients,
} from "@t3tools/client-runtime/source-control-clients";
import type { EnvironmentId, PullRequestDetailView, PullRequestRef } from "@t3tools/contracts";
import { MessageSquareIcon, Trash2Icon, XIcon } from "lucide-react";
import { useRef, useState } from "react";

import { Button } from "../ui/button";
import { Popover, PopoverClose, PopoverPopup, PopoverTitle, PopoverTrigger } from "../ui/popover";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import { usePendingReviewCommentActions } from "./usePendingReviewCommentActions";
import { PullRequestCommentForm } from "./PullRequestCommentForm";
import { PullRequestReviewForm } from "./PullRequestReviewForm";
import {
  pendingReviewDiscardTargets,
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
}) {
  const term = sourceControlClients.get(detail.provider).changeRequest.singular;
  const [open, setOpen] = useState(false);
  const [reviewPending, setReviewPending] = useState(false);
  const [requestedMode, setRequestedMode] = useState<"comment" | "review">("comment");
  const commentRef = useRef<HTMLTextAreaElement>(null);
  const reviewRef = useRef<HTMLTextAreaElement>(null);
  const { key: reviewKey, ready: reviewReady } = usePullRequestReviewScope(
    environmentId,
    reference,
  );
  const storedComments = usePendingReviewComments(reviewKey, detail.reviewThreads);
  const pendingComments = reviewReady ? storedComments : [];
  const {
    busy: draftBusy,
    canDiscard,
    discardAll,
  } = usePendingReviewCommentActions(environmentId, reference);
  // A summary typed but not sent is review work too, and it outlives the popover. Selected as a
  // boolean rather than the text, so typing one does not re-render the composer per keystroke.
  const summaryStarted = usePullRequestReviewStore(
    (store) => reviewReady && (store.summaries[reviewKey] ?? "").trim().length > 0,
  );
  const removedIds = usePullRequestReviewStore((store) => store.removedHostComments[reviewKey]);
  const discardTargets = reviewReady
    ? pendingReviewDiscardTargets(pendingComments, detail.reviewThreads, removedIds)
    : [];
  const pendingCount = reviewReady
    ? pendingComments.length +
      pendingReviewIdentityFromThreads(detail.reviewThreads, removedIds).outdatedComments.length
    : 0;
  const reviewStarted = pendingCount > 0 || summaryStarted;
  const [answeredOpenRequest, setAnsweredOpenRequest] = useState(openReviewRequest);
  if (openReviewRequest !== answeredOpenRequest) {
    setAnsweredOpenRequest(openReviewRequest);
    setRequestedMode("review");
    setOpen(true);
  }

  const canComment = detail.capabilities.comment && detail.viewerPermissions.comment;
  const verdicts = detail.capabilities.review.verdicts.filter((verdict) =>
    detail.viewerPermissions.verdicts.includes(verdict),
  );
  if (!canComment && verdicts.length === 0) return null;

  const mode = canComment ? (verdicts.length === 0 ? "comment" : requestedMode) : "review";

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        if (next) setRequestedMode(reviewStarted ? "review" : "comment");
        setOpen(next);
      }}
    >
      <PopoverTrigger
        render={<Button size="icon" variant="glass" />}
        aria-label={
          pendingCount > 0
            ? `Review ${term}, ${pendingCount} ${pendingCount === 1 ? "comment" : "comments"} pending`
            : reviewStarted || !canComment
              ? `Review ${term}`
              : `Comment on ${term}`
        }
      >
        <MessageSquareIcon className="size-4" />
        {pendingCount > 0 ? (
          <span
            aria-hidden
            className="absolute -top-1 -right-1 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-info px-1 text-3xs font-semibold tabular-nums text-white"
          >
            {pendingCount}
          </span>
        ) : null}
      </PopoverTrigger>
      <PopoverPopup
        keepMounted
        side="top"
        align="end"
        sideOffset={8}
        width="lg"
        initialFocus={mode === "review" ? reviewRef : commentRef}
        aria-label={`${capitalizeTerm(term)} composer`}
      >
        <div className="mb-3 flex items-center justify-between gap-2">
          {canComment && verdicts.length > 0 ? (
            <ToggleGroup
              aria-label="Composer mode"
              variant="segmented"
              value={[mode]}
              onValueChange={(next) => {
                const value = next[0];
                if (value === "comment" || value === "review") setRequestedMode(value);
              }}
            >
              <Toggle value="comment">Comment</Toggle>
              <Toggle value="review">
                {pendingCount > 0 ? `Review (${pendingCount})` : "Review"}
              </Toggle>
            </ToggleGroup>
          ) : (
            <PopoverTitle>
              {mode === "review" ? `Review ${term}` : `Comment on ${term}`}
            </PopoverTitle>
          )}
          <div className="flex items-center gap-1">
            {mode === "review" && discardTargets.length > 0 ? (
              <Button
                size="icon-xs"
                variant="ghost"
                aria-label="Discard pending line comments"
                title="Discard pending line comments"
                disabled={
                  reviewPending ||
                  draftBusy ||
                  (!canDiscard &&
                    discardTargets.some((comment) => comment.hostedComment !== undefined))
                }
                onClick={() => void discardAll(discardTargets)}
              >
                <Trash2Icon className="size-3.5" />
              </Button>
            ) : null}
            <PopoverClose
              render={<Button size="icon-xs" variant="ghost" />}
              aria-label="Close composer"
            >
              <XIcon className="size-3.5" />
            </PopoverClose>
          </div>
        </div>
        {/* Keep forms mounted to preserve drafts and submit guards across dismissal. */}
        {verdicts.length > 0 ? (
          <div hidden={mode !== "review"}>
            <PullRequestReviewForm
              active={open && mode === "review"}
              environmentId={environmentId}
              reference={reference}
              completionScope={pullRequestCompletionScope(detail, environmentId, reference)}
              term={term}
              reviewThreads={detail.reviewThreads}
              verdicts={verdicts}
              requestChangesSummaryRequired={sourceControlClients
                .get(detail.provider)
                .reviewSummaryRequired("request-changes")}
              textareaRef={reviewRef}
              pending={reviewPending}
              onPendingChange={setReviewPending}
              onSubmitted={() => {
                setOpen(false);
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
              onClose={() => setOpen(false)}
            />
          </div>
        ) : null}
      </PopoverPopup>
    </Popover>
  );
}

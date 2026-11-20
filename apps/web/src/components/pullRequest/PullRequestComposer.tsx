import { sourceControlClients } from "@t3tools/client-runtime/source-control-clients";
/** Comment and review drafts stay separate across verdict switches and dock dismissal. */
import type {
  EnvironmentId,
  PullRequestDetailView,
  PullRequestRef,
  PullRequestReviewVerdict,
} from "@t3tools/contracts";
import { MessageSquareTextIcon } from "lucide-react";
import { T, useGT } from "gt-react";
import { useRef, useState } from "react";

import { PopoverTitle } from "../ui/popover";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import {
  WorkItemComposerClose,
  WorkItemComposerPopover,
} from "../workItem/WorkItemComposerPopover";
import { PullRequestCommentForm } from "./PullRequestCommentForm";
import { PullRequestReviewForm } from "./PullRequestReviewForm";
import {
  pullRequestReviewKey,
  usePendingReviewComments,
  usePullRequestReviewStore,
} from "./pullRequestReviewStore";
import { pullRequestCompletionScope } from "./PullRequestMarkdownTextarea";

import { changeRequestTermKind } from "./changeRequestTerm";

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
  const gt = useGT();
  const term = changeRequestTermKind(sourceControlClients.get(detail.provider).changeRequest);
  // "review" is open from a review request, which offers the review over a plain comment.
  const [popover, setPopover] = useState<"closed" | "open" | "review">("closed");
  const open = popover !== "closed";
  const reviewRequested = popover === "review";
  const [reviewPending, setReviewPending] = useState(false);
  const [requestedMode, setRequestedMode] = useState<PullRequestReviewVerdict>("comment");
  const commentRef = useRef<HTMLTextAreaElement>(null);
  const reviewRef = useRef<HTMLTextAreaElement>(null);
  const pendingComments = usePendingReviewComments(reference);
  // Unsent summaries outlive the popover; select a boolean to avoid per-keystroke renders.
  const reviewKey = pullRequestReviewKey(reference);
  const summaryStarted = usePullRequestReviewStore(
    (store) => (store.summaries[reviewKey] ?? "").trim().length > 0,
  );
  const reviewStarted = pendingComments.length > 0 || summaryStarted;
  const [answeredOpenRequest, setAnsweredOpenRequest] = useState(openReviewRequest);
  if (openReviewRequest !== answeredOpenRequest) {
    setAnsweredOpenRequest(openReviewRequest);
    setPopover("review");
  }

  const canComment = detail.capabilities.comment && detail.viewerPermissions.comment;
  const verdicts = detail.capabilities.review.verdicts.filter((verdict) =>
    detail.viewerPermissions.verdicts.includes(verdict),
  );
  if (!canComment && verdicts.length === 0) return null;

  // Comment is offered wherever a plain remark or a commented review can be sent.
  const modes = (["comment", "approve", "request-changes"] as const).filter((mode) =>
    mode === "comment"
      ? (!reviewRequested && canComment) || verdicts.includes("comment")
      : verdicts.includes(mode),
  );
  const mode = modes.includes(requestedMode) ? requestedMode : (modes[0] ?? "comment");
  // A review is what is sent when line comments or a summary have been started.
  const sendsReview =
    mode !== "comment" ||
    !canComment ||
    (verdicts.includes("comment") && (reviewStarted || reviewRequested));

  const close = <WorkItemComposerClose />;
  const modePicker =
    modes.length > 1 ? (
      <ToggleGroup
        aria-label={gt("Composer mode")}
        variant="segmented"
        value={[mode]}
        onValueChange={(next) => {
          const value = modes.find((candidate) => candidate === next[0]);
          if (value) setRequestedMode(value);
        }}
      >
        {modes.map((value) => (
          <Toggle key={value} value={value}>
            {value === "comment"
              ? gt("Comment", { $context: "review verdict" })
              : value === "approve"
                ? gt("Approve", { $context: "review verdict" })
                : gt("Request changes")}
          </Toggle>
        ))}
      </ToggleGroup>
    ) : null;

  return (
    <WorkItemComposerPopover
      open={open}
      onOpenChange={(next) => {
        // The last mode is kept: line comments waiting already turn Comment into the review.
        setPopover((current) => (!next ? "closed" : current === "closed" ? "open" : current));
      }}
      triggerLabel={
        pendingComments.length > 0
          ? gt(
              "{count, plural, one {Review {term, select, mr {merge request} cr {change request} other {pull request}}, {count} comment pending} other {Review {term, select, mr {merge request} cr {change request} other {pull request}}, {count} comments pending}}",
              { count: pendingComments.length, term },
            )
          : reviewStarted || !canComment
            ? gt(
                "Review {term, select, mr {merge request} cr {change request} other {pull request}}",
                { term },
              )
            : gt(
                "Comment on {term, select, mr {merge request} cr {change request} other {pull request}}",
                { term },
              )
      }
      badge={
        pendingComments.length > 0 ? (
          <span
            aria-hidden
            className="absolute -top-1 -right-1 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-info/15 px-1 text-micro tabular-nums text-info-foreground"
          >
            {pendingComments.length}
          </span>
        ) : null
      }
      initialFocus={sendsReview ? reviewRef : commentRef}
      popupLabel={gt(
        "{term, select, mr {Merge request} cr {Change request} other {Pull request}} composer",
        { term },
      )}
      header={
        // With line comments waiting, the review header takes the title row and the verdicts
        // sit under it; otherwise the verdicts, or the plain title, share the row with close.
        pendingComments.length > 0 ? (
          <>
            <div className="mb-2 flex items-center gap-2 text-body">
              <MessageSquareTextIcon aria-hidden className="size-4 text-muted-foreground" />
              <PopoverTitle>
                <T>Your review</T>
              </PopoverTitle>
              <span className="min-w-0 flex-1 truncate text-meta text-muted-foreground">
                {gt(
                  "{count, plural, one {{count} pending comment} other {{count} pending comments}}",
                  { count: pendingComments.length },
                )}
              </span>
              {close}
            </div>
            {modePicker ? <div className="mb-3">{modePicker}</div> : null}
          </>
        ) : (
          <div className="mb-3 flex items-center justify-between gap-2">
            {modePicker ?? (
              <PopoverTitle>
                {sendsReview
                  ? gt(
                      "Review {term, select, mr {merge request} cr {change request} other {pull request}}",
                      { term },
                    )
                  : gt(
                      "Comment on {term, select, mr {merge request} cr {change request} other {pull request}}",
                      { term },
                    )}
              </PopoverTitle>
            )}
            {close}
          </div>
        )
      }
    >
      {/* Keep forms mounted to preserve drafts and submit guards across dismissal. */}
      {verdicts.length > 0 ? (
        <div hidden={!sendsReview}>
          <PullRequestReviewForm
            active={open && sendsReview}
            environmentId={environmentId}
            reference={reference}
            completionScope={pullRequestCompletionScope(detail, environmentId, reference)}
            verdict={mode}
            term={term}
            requestChangesSummaryRequired={sourceControlClients
              .get(detail.provider)
              .reviewSummaryRequired("request-changes")}
            textareaRef={reviewRef}
            pending={reviewPending}
            onPendingChange={setReviewPending}
            onSubmitted={() => {
              setPopover("closed");
              onReviewSubmitted();
            }}
          />
        </div>
      ) : null}
      {canComment ? (
        <div hidden={sendsReview}>
          <PullRequestCommentForm
            active={open && mode === "comment"}
            environmentId={environmentId}
            reference={reference}
            detail={detail}
            actionPending={actionPending}
            textareaRef={commentRef}
            onCommentAction={onCommentAction}
            onCommented={onCommented}
            onClose={() => {
              setPopover("closed");
            }}
          />
        </div>
      ) : null}
    </WorkItemComposerPopover>
  );
}

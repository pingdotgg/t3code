import {
  capitalizeTerm,
  sourceControlClients,
} from "@t3tools/client-runtime/source-control-clients";
/** Comment and review drafts stay separate across verdict switches and dock dismissal. */
import type {
  EnvironmentId,
  PullRequestDetailView,
  PullRequestRef,
  PullRequestReviewVerdict,
} from "@t3tools/contracts";
import { MessageSquareIcon, MessageSquareTextIcon, XIcon } from "lucide-react";
import { useRef, useState } from "react";

import { Button } from "../ui/button";
import { Popover, PopoverClose, PopoverPopup, PopoverTitle, PopoverTrigger } from "../ui/popover";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import { PullRequestCommentForm } from "./PullRequestCommentForm";
import { PullRequestReviewForm } from "./PullRequestReviewForm";
import {
  pullRequestReviewKey,
  usePendingReviewComments,
  usePullRequestReviewStore,
} from "./pullRequestReviewStore";

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
  const [reviewRequested, setReviewRequested] = useState(false);
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
    setReviewRequested(true);
    setOpen(true);
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

  const close = (
    <PopoverClose render={<Button size="icon-xs" variant="ghost" />} aria-label="Close composer">
      <XIcon className="size-3.5" />
    </PopoverClose>
  );
  const modePicker =
    modes.length > 1 ? (
      <ToggleGroup
        aria-label="Composer mode"
        variant="segmented"
        value={[mode]}
        onValueChange={(next) => {
          const value = modes.find((candidate) => candidate === next[0]);
          if (value) setRequestedMode(value);
        }}
      >
        {modes.map((value) => (
          <Toggle key={value} value={value}>
            {value === "comment" ? "Comment" : value === "approve" ? "Approve" : "Request changes"}
          </Toggle>
        ))}
      </ToggleGroup>
    ) : null;

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        // The last mode is kept: line comments waiting already turn Comment into the review.
        if (!next) setReviewRequested(false);
        setOpen(next);
      }}
    >
      <PopoverTrigger
        render={<Button size="icon" variant="floating" />}
        aria-label={
          pendingComments.length > 0
            ? `Review ${term}, ${pendingComments.length} ${pendingComments.length === 1 ? "comment" : "comments"} pending`
            : reviewStarted || !canComment
              ? `Review ${term}`
              : `Comment on ${term}`
        }
      >
        <MessageSquareIcon className="size-4" />
        {pendingComments.length > 0 ? (
          <span
            aria-hidden
            className="absolute -top-1 -right-1 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-info/15 px-1 text-micro tabular-nums text-info-foreground"
          >
            {pendingComments.length}
          </span>
        ) : null}
      </PopoverTrigger>
      <PopoverPopup
        keepMounted
        side="top"
        align="end"
        sideOffset={8}
        width="lg"
        initialFocus={sendsReview ? reviewRef : commentRef}
        aria-label={`${capitalizeTerm(term)} composer`}
      >
        {/* With line comments waiting, the review header takes the title row and the verdicts
            sit under it; otherwise the verdicts, or the plain title, share the row with close. */}
        {pendingComments.length > 0 ? (
          <>
            <div className="mb-2 flex items-center gap-2 text-body">
              <MessageSquareTextIcon aria-hidden className="size-4 text-muted-foreground" />
              <PopoverTitle>Your review</PopoverTitle>
              <span className="min-w-0 flex-1 truncate text-meta text-muted-foreground">
                {pendingComments.length} pending{" "}
                {pendingComments.length === 1 ? "comment" : "comments"}
              </span>
              {close}
            </div>
            {modePicker ? <div className="mb-3">{modePicker}</div> : null}
          </>
        ) : (
          <div className="mb-3 flex items-center justify-between gap-2">
            {modePicker ?? (
              <PopoverTitle>{sendsReview ? `Review ${term}` : `Comment on ${term}`}</PopoverTitle>
            )}
            {close}
          </div>
        )}
        {/* Keep forms mounted to preserve drafts and submit guards across dismissal. */}
        {verdicts.length > 0 ? (
          <div hidden={!sendsReview}>
            <PullRequestReviewForm
              active={open && sendsReview}
              environmentId={environmentId}
              reference={reference}
              verdict={mode}
              term={term}
              requestChangesSummaryRequired={sourceControlClients
                .get(detail.provider)
                .reviewSummaryRequired("request-changes")}
              textareaRef={reviewRef}
              pending={reviewPending}
              onPendingChange={setReviewPending}
              onSubmitted={() => {
                setOpen(false);
                setReviewRequested(false);
                onReviewSubmitted();
              }}
            />
          </div>
        ) : null}
        {canComment ? (
          <div hidden={sendsReview}>
            <PullRequestCommentForm
              active={open && !sendsReview}
              environmentId={environmentId}
              reference={reference}
              detail={detail}
              actionPending={actionPending}
              textareaRef={commentRef}
              onCommentAction={onCommentAction}
              onCommented={onCommented}
              onClose={() => {
                setOpen(false);
                setReviewRequested(false);
              }}
            />
          </div>
        ) : null}
      </PopoverPopup>
    </Popover>
  );
}

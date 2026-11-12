import { pendingReviewIdentityFromThreads } from "@t3tools/client-runtime/review-editing";
import { usePullRequestReviewScope } from "./usePullRequestReviewKey";
import { usePendingReviewCommentActions } from "./usePendingReviewCommentActions";
import { PullRequestAttachments } from "./PullRequestAttachments";
import { useAtomCommand } from "~/state/use-atom-command";
import { capitalizeTerm } from "@t3tools/client-runtime/source-control-clients";
/**
 * The review half of the floating composer: the summary and the verdict that sends it, together
 * with whatever line comments the review is holding. The count of those lives on the composer's
 * trigger and mode toggle, and each pending card can be dropped from the diff, so neither is
 * repeated here. The popover around it belongs to PullRequestComposer.
 */
import type {
  EnvironmentId,
  PullRequestRef,
  PullRequestReviewThread,
  PullRequestReviewVerdict,
} from "@t3tools/contracts";
import { CheckIcon, MessageSquareIcon, XCircleIcon } from "lucide-react";
import { useEffect, useState, type ReactNode, type RefObject } from "react";

import { TextFieldSpeechControls, useTextFieldSpeech } from "~/speech/useTextFieldSpeech";
import { pullRequestEnvironment } from "~/state/pullRequests";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";

import { isCommentSubmitShortcut } from "../diffs/commentSubmitShortcut";
import { Button } from "../ui/button";
import { Select, SelectItem, SelectPopup, SelectTrigger } from "../ui/select";
import { toastManager } from "../ui/toast";
import { readableFailure } from "./pullRequestDetail.logic";
import {
  mergePendingReviewComments,
  usePendingReviewComments,
  usePullRequestReviewStore,
} from "./pullRequestReviewStore";
import {
  PullRequestMarkdownTextarea,
  type PullRequestCompletionScope,
} from "./PullRequestMarkdownTextarea";

const VERDICTS: ReadonlyArray<{
  readonly value: PullRequestReviewVerdict;
  readonly label: string;
  readonly sent: (term: string) => string;
  readonly icon: ReactNode;
}> = [
  {
    value: "comment",
    label: "Comment",
    sent: () => "Review submitted",
    icon: <MessageSquareIcon className="size-3" />,
  },
  {
    value: "approve",
    label: "Approve",
    sent: (term) => `${capitalizeTerm(term)} approved`,
    icon: <CheckIcon className="size-3" />,
  },
  {
    value: "request-changes",
    label: "Request changes",
    sent: () => "Changes requested",
    icon: <XCircleIcon className="size-3" />,
  },
];

export function PullRequestReviewForm({
  environmentId,
  active,
  reference,
  completionScope,
  term,
  reviewThreads,
  verdicts,
  requestChangesSummaryRequired,
  textareaRef,
  pending,
  onPendingChange,
  onSubmitted,
}: {
  environmentId: EnvironmentId;
  /** False while the form stays mounted but hidden; dictation is cancelled then. */
  active: boolean;
  reference: PullRequestRef;
  completionScope: PullRequestCompletionScope | null;
  /** The host's word for a change request, as in "pull request". */
  term: string;
  reviewThreads: ReadonlyArray<PullRequestReviewThread>;
  verdicts: ReadonlyArray<PullRequestReviewVerdict>;
  requestChangesSummaryRequired: boolean;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  pending: boolean;
  onPendingChange: (pending: boolean) => void;
  onSubmitted: () => void;
}) {
  const { busy: draftBusy } = usePendingReviewCommentActions(environmentId, reference);
  const [uploading, setUploading] = useState(false);
  const [requestedVerdict, setRequestedVerdict] = useState<PullRequestReviewVerdict>("comment");
  const { key: reviewKey, ready: reviewReady } = usePullRequestReviewScope(
    environmentId,
    reference,
  );
  const comments = usePendingReviewComments(reviewKey, reviewThreads);
  const removedIds = usePullRequestReviewStore((store) => store.removedHostComments[reviewKey]);
  const remoteIdentity = pendingReviewIdentityFromThreads(reviewThreads, removedIds);
  const pendingReviewId =
    comments.find((comment) => comment.hostedComment)?.hostedComment?.reviewId ??
    remoteIdentity.pendingReviewId;
  // The panel stays mounted while the selected pull request changes. Keeping summaries beside
  // the keyed line-comment drafts makes the selected pull request's body correct on the first
  // render, before an effect could reset state left behind by the previous one.
  const storedBody = usePullRequestReviewStore((store) => store.summaries[reviewKey] ?? "");
  const body = reviewReady ? storedBody : "";
  const removeComments = usePullRequestReviewStore((store) => store.removeComments);
  const setSummary = usePullRequestReviewStore((store) => store.setSummary);
  const updateSummary = (text: string) => {
    if (reviewReady) setSummary(reviewKey, text);
  };
  const speech = useTextFieldSpeech({
    environmentId,
    projectId: reference.projectId,
    ownerKey: JSON.stringify(["pr-review", environmentId, reviewKey]),
    text: body,
    textareaRef,
    onTextChange: updateSummary,
    disabled: !reviewReady || !active || pending,
  });
  const { cancel } = speech;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- discards a recording when the hidden form can no longer be submitted
  useEffect(() => {
    if (!active) cancel();
  }, [active, cancel]);
  const clearSummary = usePullRequestReviewStore((store) => store.clearSummary);
  const submitReview = useAtomCommand(pullRequestEnvironment.submitReview, {
    reportFailure: false,
  });

  const offered = VERDICTS.filter((verdict) => verdicts.includes(verdict.value));
  const selectedVerdict =
    offered.find((verdict) => verdict.value === requestedVerdict) ?? offered[0];

  const submit = async (verdict: (typeof VERDICTS)[number], text: string) => {
    const state = usePullRequestReviewStore.getState();
    const submittedComments = mergePendingReviewComments(
      state.drafts[reviewKey] ?? [],
      reviewThreads,
      state.removedHostComments[reviewKey] ?? [],
    );
    const identity = pendingReviewIdentityFromThreads(
      reviewThreads,
      state.removedHostComments[reviewKey],
    );
    const submittedReviewId =
      submittedComments.find((comment) => comment.hostedComment)?.hostedComment?.reviewId ??
      identity.pendingReviewId;
    if (
      !reviewReady ||
      pending ||
      uploading ||
      draftBusy ||
      !canSubmit(verdict.value, text, submittedComments.length, submittedReviewId)
    )
      return;
    const submittedBody = text;
    onPendingChange(true);
    const result = await submitReview({
      environmentId,
      input: {
        ...reference,
        verdict: verdict.value,
        ...(submittedReviewId ? { pendingReviewId: submittedReviewId } : {}),
        body: submittedBody,
        comments: submittedComments,
        ...(identity.outdatedComments.length
          ? { outdatedComments: identity.outdatedComments }
          : {}),
      },
    });
    onPendingChange(false);
    if (result._tag === "Failure") {
      toastManager.add({
        type: "error",
        title: "The review could not be submitted",
        description: readableFailure(
          squashAtomCommandFailure(result),
          "The host refused the review. Your draft is still here to try again.",
        ),
      });
      return;
    }
    // Preserve comments and summary edits made during submission.
    removeComments(
      reviewKey,
      [
        ...submittedComments.map((comment) => comment.id),
        ...(state.drafts[reviewKey] ?? [])
          .filter((comment) =>
            identity.outdatedComments.some(
              (outdated) => outdated.id === comment.hostedComment?.commentId,
            ),
          )
          .map((comment) => comment.id),
      ],
      [
        ...identity.outdatedComments.map((comment) => comment.id),
        ...submittedComments.flatMap((comment) =>
          comment.hostedComment ? [comment.hostedComment.commentId] : [],
        ),
      ],
    );
    clearSummary(reviewKey, submittedBody);
    toastManager.add({ type: "success", title: verdict.sent(term) });
    onSubmitted();
  };

  // Forgejo requires a summary when requesting changes, even with inline comments.
  const canSubmit = (
    verdict: PullRequestReviewVerdict,
    summary: string,
    commentCount: number,
    reviewId: string | undefined = pendingReviewId,
  ) =>
    verdict === "request-changes" && requestChangesSummaryRequired
      ? summary.trim().length > 0
      : verdict === "approve" ||
        summary.trim().length > 0 ||
        commentCount > 0 ||
        reviewId !== undefined;
  const placeholder =
    selectedVerdict === undefined || canSubmit(selectedVerdict.value, "", comments.length)
      ? "Summarize your review (optional)"
      : selectedVerdict.value === "request-changes" && requestChangesSummaryRequired
        ? "Summarize your review (required to request changes)"
        : "Summarize your review or add line comments";

  return (
    <>
      <PullRequestMarkdownTextarea
        ref={textareaRef}
        completionScope={completionScope}
        disabled={!reviewReady || pending || uploading || draftBusy}
        rows={3}
        readOnly={speech.freezesEditor}
        value={body}
        placeholder={placeholder}
        aria-label="Review summary"
        onValueChange={updateSummary}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing || event.keyCode === 229 || event.repeat) return;
          if (
            selectedVerdict !== undefined &&
            isCommentSubmitShortcut(event, body, pending || speech.preparing, true)
          ) {
            event.preventDefault();
            event.stopPropagation();
            speech.submitAfterDictation((text) => void submit(selectedVerdict, text));
          }
        }}
      />
      <PullRequestAttachments
        environmentId={environmentId}
        reference={reference}
        disabled={!reviewReady || pending}
        onBusyChange={setUploading}
        textareaRef={textareaRef}
        onTextChange={updateSummary}
      />
      <div className="mt-2 flex flex-wrap items-center justify-end gap-2">
        <TextFieldSpeechControls speech={speech} disabled={!reviewReady || pending} />
        {offered.length > 1 ? (
          <Select
            value={selectedVerdict?.value ?? null}
            disabled={!reviewReady || pending || uploading || draftBusy}
            onValueChange={(value) => {
              if (value !== null) setRequestedVerdict(value);
            }}
          >
            <SelectTrigger size="xs" className="w-auto min-w-0" aria-label="Review verdict">
              <span className="flex items-center gap-1.5">
                {selectedVerdict?.icon}
                {selectedVerdict?.label}
              </span>
            </SelectTrigger>
            <SelectPopup side="top" alignItemWithTrigger={false}>
              {offered.map((verdict) => (
                <SelectItem key={verdict.value} value={verdict.value}>
                  <span className="flex items-center gap-1.5">
                    {verdict.icon}
                    {verdict.label}
                  </span>
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        ) : null}
        <Button
          size="xs"
          disabled={
            !reviewReady ||
            speech.preparing ||
            pending ||
            uploading ||
            draftBusy ||
            selectedVerdict === undefined ||
            (!canSubmit(selectedVerdict.value, body, comments.length) && !speech.blocksSubmission)
          }
          onClick={() => {
            if (selectedVerdict !== undefined)
              speech.submitAfterDictation((text) => void submit(selectedVerdict, text));
          }}
        >
          {pending ? "Submitting..." : "Submit review"}
        </Button>
      </div>
    </>
  );
}

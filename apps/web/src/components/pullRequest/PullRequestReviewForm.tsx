import { useAtomCommand } from "~/state/use-atom-command";
import { capitalizeTerm } from "@t3tools/client-runtime/source-control-clients";
/**
 * with whatever line comments the review is holding. The verdict is picked by the composer's
 * segmented control; the popover around it belongs to PullRequestComposer.
 */
import type { EnvironmentId, PullRequestRef, PullRequestReviewVerdict } from "@t3tools/contracts";
import { MessageSquareIcon, XIcon } from "lucide-react";
import { useEffect, type RefObject } from "react";

import { TextFieldSpeechControls, useTextFieldSpeech } from "~/speech/useTextFieldSpeech";
import { pullRequestEnvironment } from "~/state/pullRequests";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";

import { isCommentSubmitShortcut } from "../diffs/commentSubmitShortcut";
import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";
import { readableFailure } from "./pullRequestDetail.logic";
import { PullRequestSubmitKeyHint } from "./PullRequestSubmitKeyHint";
import {
  pullRequestReviewKey,
  usePendingReviewComments,
  usePullRequestReviewStore,
} from "./pullRequestReviewStore";
import {
  PullRequestMarkdownTextarea,
  type PullRequestCompletionScope,
} from "./PullRequestMarkdownTextarea";

const sent = (term: string): Record<PullRequestReviewVerdict, string> => ({
  comment: "Review submitted",
  approve: `${capitalizeTerm(term)} approved`,
  "request-changes": "Changes requested",
});

export function PullRequestReviewForm({
  environmentId,
  active,
  reference,
  completionScope,
  verdict,
  term,
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
  verdict: PullRequestReviewVerdict;
  /** The host's word for a change request, as in "pull request". */
  term: string;
  requestChangesSummaryRequired: boolean;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  pending: boolean;
  onPendingChange: (pending: boolean) => void;
  onSubmitted: () => void;
}) {
  const comments = usePendingReviewComments(reference);
  const reviewKey = pullRequestReviewKey(reference);
  const body = usePullRequestReviewStore((store) => store.summaries[reviewKey] ?? "");
  const removeComments = usePullRequestReviewStore((store) => store.removeComments);
  const setSummary = usePullRequestReviewStore((store) => store.setSummary);
  const speech = useTextFieldSpeech({
    environmentId,
    projectId: reference.projectId,
    ownerKey: JSON.stringify(["pr-review", environmentId, reviewKey]),
    text: body,
    textareaRef,
    onTextChange: (text) => setSummary(reviewKey, text),
    disabled: !active || pending,
  });
  const { cancel } = speech;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- discards a recording when the hidden form can no longer be submitted
  useEffect(() => {
    if (!active) cancel();
  }, [active, cancel]);
  const clearSummary = usePullRequestReviewStore((store) => store.clearSummary);
  const clearComments = usePullRequestReviewStore((store) => store.clear);
  const submitReview = useAtomCommand(pullRequestEnvironment.submitReview, {
    reportFailure: false,
  });

  const submit = async (text: string) => {
    const submittedComments = usePullRequestReviewStore.getState().drafts[reviewKey] ?? [];
    if (pending || !canSubmitReview(verdict, text, submittedComments.length)) return;
    const submittedBody = text;
    onPendingChange(true);
    const result = await submitReview({
      environmentId,
      input: {
        ...reference,
        verdict,
        body: submittedBody,
        comments: submittedComments,
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
      submittedComments.map((comment) => comment.id),
    );
    clearSummary(reviewKey, submittedBody);
    toastManager.add({ type: "success", title: sent(term)[verdict] });
    onSubmitted();
  };

  // Forgejo requires a summary when requesting changes, even with inline comments.
  const canSubmitReview = (
    verdict: PullRequestReviewVerdict,
    summary: string,
    commentCount: number,
  ) =>
    verdict === "request-changes" && requestChangesSummaryRequired
      ? summary.trim().length > 0
      : verdict === "approve" || summary.trim().length > 0 || commentCount > 0;
  const canSubmit = canSubmitReview(verdict, body, comments.length);
  const placeholder = canSubmitReview(verdict, "", comments.length)
    ? "Summarize your review (optional)"
    : verdict === "request-changes" && requestChangesSummaryRequired
      ? "Summarize your review (required to request changes)"
      : "Summarize your review or add line comments";

  return (
    <>
      <PullRequestMarkdownTextarea
        ref={textareaRef}
        completionScope={completionScope}
        rows={3}
        readOnly={speech.freezesEditor}
        value={speech.displayText}
        placeholder={placeholder}
        aria-label="Review summary"
        onValueChange={(next) => setSummary(reviewKey, next)}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing || event.keyCode === 229 || event.repeat) return;
          // Approving takes no words, so the chord submits an empty summary too.
          if (isCommentSubmitShortcut(event, body, pending || speech.preparing, true)) {
            event.preventDefault();
            event.stopPropagation();
            speech.submitAfterDictation((text) => void submit(text));
          }
        }}
      />
      <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
          {comments.length > 0 ? (
            <span className="inline-flex min-w-0 items-center gap-1.5 rounded-row border border-border py-0.5 pr-0.5 pl-2 text-meta text-muted-foreground">
              <MessageSquareIcon aria-hidden className="size-3.5 shrink-0" />
              <span className="truncate">
                {comments.length} line {comments.length === 1 ? "comment" : "comments"}
              </span>
              <Button
                size="icon-micro"
                variant="ghost-muted"
                aria-label="Discard pending line comments"
                disabled={pending}
                onClick={() => clearComments(reviewKey)}
              >
                <XIcon className="size-3" />
              </Button>
            </span>
          ) : null}
          <TextFieldSpeechControls speech={speech} disabled={pending} />
        </div>
        <Button
          size="xs"
          disabled={speech.preparing || pending || (!canSubmit && !speech.blocksSubmission)}
          onClick={() => speech.submitAfterDictation((text) => void submit(text))}
        >
          {pending ? "Submitting..." : "Submit review"}
          <PullRequestSubmitKeyHint />
        </Button>
      </div>
    </>
  );
}

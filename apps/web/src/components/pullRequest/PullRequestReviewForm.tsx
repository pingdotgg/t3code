import { useAtomCommand } from "~/state/use-atom-command";
import { capitalizeTerm } from "@t3tools/client-runtime/source-control-clients";
/**
 * with whatever line comments the review is holding. The verdict is picked by the composer's
 * segmented control; the popover around it belongs to PullRequestComposer.
 */
import type { EnvironmentId, PullRequestRef, PullRequestReviewVerdict } from "@t3tools/contracts";
import { MessageSquareIcon, XIcon } from "lucide-react";
import type { RefObject } from "react";

import { pullRequestEnvironment } from "~/state/pullRequests";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";

import { Button } from "../ui/button";
import { Textarea } from "../ui/textarea";
import { toastManager } from "../ui/toast";
import { readableFailure } from "./pullRequestDetail.logic";
import { PullRequestSubmitKeyHint } from "./PullRequestSubmitKeyHint";
import {
  pullRequestReviewKey,
  usePendingReviewComments,
  usePullRequestReviewStore,
} from "./pullRequestReviewStore";

const sent = (term: string): Record<PullRequestReviewVerdict, string> => ({
  comment: "Review submitted",
  approve: `${capitalizeTerm(term)} approved`,
  "request-changes": "Changes requested",
});

export function PullRequestReviewForm({
  environmentId,
  reference,
  verdict,
  term,
  requestChangesSummaryRequired,
  textareaRef,
  pending,
  onPendingChange,
  onSubmitted,
}: {
  environmentId: EnvironmentId;
  reference: PullRequestRef;
  verdict: PullRequestReviewVerdict;
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
  const clearSummary = usePullRequestReviewStore((store) => store.clearSummary);
  const clearComments = usePullRequestReviewStore((store) => store.clear);
  const submitReview = useAtomCommand(pullRequestEnvironment.submitReview, {
    reportFailure: false,
  });

  const submit = async () => {
    if (pending || !canSubmit) return;
    const submittedBody = body;
    const submittedComments = comments;
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
  const canSubmitReview = (verdict: PullRequestReviewVerdict, summary: string) =>
    verdict === "request-changes" && requestChangesSummaryRequired
      ? summary.trim().length > 0
      : verdict === "approve" || summary.trim().length > 0 || comments.length > 0;
  const canSubmit = canSubmitReview(verdict, body);
  const placeholder = canSubmitReview(verdict, "")
    ? "Summarize your review (optional)"
    : verdict === "request-changes" && requestChangesSummaryRequired
      ? "Summarize your review (required to request changes)"
      : "Summarize your review or add line comments";

  return (
    <>
      <Textarea
        ref={textareaRef}
        rows={3}
        value={body}
        placeholder={placeholder}
        aria-label="Review summary"
        onChange={(event) => setSummary(reviewKey, event.target.value)}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing) return;
          // Approving takes no words, so the chord submits an empty summary too.
          if ((event.metaKey || event.ctrlKey) && event.key === "Enter" && !pending && canSubmit) {
            event.preventDefault();
            event.stopPropagation();
            if (!event.repeat) void submit();
          }
        }}
      />
      <div className="mt-2 flex items-center justify-between gap-2">
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
        ) : (
          <span />
        )}
        <Button size="xs" disabled={pending || !canSubmit} onClick={() => void submit()}>
          {pending ? "Submitting..." : "Submit review"}
          <PullRequestSubmitKeyHint />
        </Button>
      </div>
    </>
  );
}

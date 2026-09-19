/**
 * The review form floated over the Code tab: how many comments the review is holding, its
 * summary, and the verdict that sends the lot. Hidden entirely on a host that cannot take a
 * review. The glass card frame belongs to the caller (PullRequestCodeTab), which is why this
 * only contributes its own padding.
 */
import type { EnvironmentId, PullRequestRef, PullRequestReviewVerdict } from "@t3tools/contracts";
import { CheckIcon, MessageSquareIcon, XCircleIcon } from "lucide-react";
import { useState, type ReactNode } from "react";

import { pullRequestEnvironment } from "~/state/pullRequests";
import { useAtomCommand } from "~/state/use-atom-command";

import { Button } from "../ui/button";
import { PullRequestMarkdownField } from "./PullRequestMarkdownField";
import { toastManager } from "../ui/toast";
import {
  pullRequestReviewKey,
  usePendingReviewComments,
  usePullRequestReviewStore,
} from "./pullRequestReviewStore";

const VERDICTS: ReadonlyArray<{
  readonly value: PullRequestReviewVerdict;
  readonly label: string;
  readonly sent: string;
  readonly icon: ReactNode;
}> = [
  {
    value: "comment",
    label: "Comment",
    sent: "Review submitted",
    icon: <MessageSquareIcon className="size-3" />,
  },
  {
    value: "approve",
    label: "Approve",
    sent: "Pull request approved",
    icon: <CheckIcon className="size-3" />,
  },
  {
    value: "request-changes",
    label: "Request changes",
    sent: "Changes requested",
    icon: <XCircleIcon className="size-3" />,
  },
];

export function PullRequestReviewBar({
  environmentId,
  reference,
  verdicts,
  requestChangesSummaryRequired,
  onSubmitted,
}: {
  environmentId: EnvironmentId;
  reference: PullRequestRef;
  verdicts: ReadonlyArray<PullRequestReviewVerdict>;
  requestChangesSummaryRequired: boolean;
  onSubmitted: () => void;
}) {
  const [uploadPending, setUploadPending] = useState(false);
  const comments = usePendingReviewComments(reference);
  const reviewKey = pullRequestReviewKey(reference);
  const pending = usePullRequestReviewStore((store) => store.submittingReviews[reviewKey] === true);
  const setReviewSubmitting = usePullRequestReviewStore((store) => store.setReviewSubmitting);
  const editingComments = usePullRequestReviewStore(
    (store) => (store.editingComments[reviewKey]?.length ?? 0) > 0,
  );
  // The panel stays mounted while the selected pull request changes. Keeping summaries beside
  // the keyed line-comment drafts makes the selected pull request's body correct on the first
  // render, before an effect could reset state left behind by the previous one.
  const body = usePullRequestReviewStore((store) => store.summaries[reviewKey] ?? "");
  const clear = usePullRequestReviewStore((store) => store.clear);
  const removeComments = usePullRequestReviewStore((store) => store.removeComments);
  const setSummary = usePullRequestReviewStore((store) => store.setSummary);
  const clearSummary = usePullRequestReviewStore((store) => store.clearSummary);
  const submitReview = useAtomCommand(pullRequestEnvironment.submitReview, {
    reportFailure: false,
  });

  const offered = VERDICTS.filter((verdict) => verdicts.includes(verdict.value));
  if (offered.length === 0) return null;

  const submit = async (verdict: (typeof VERDICTS)[number]) => {
    const store = usePullRequestReviewStore.getState();
    if (
      store.submittingReviews[reviewKey] ||
      uploadPending ||
      (store.editingComments[reviewKey]?.length ?? 0) > 0
    )
      return;
    const submittedBody = body;
    const submittedComments = comments;
    setReviewSubmitting(reviewKey, true);
    try {
      const result = await submitReview({
        environmentId,
        input: {
          ...reference,
          verdict: verdict.value,
          body: submittedBody,
          comments: submittedComments,
        },
      });
      if (result._tag === "Failure") {
        toastManager.add({ type: "error", title: "The review could not be submitted" });
        return;
      }
      removeComments(reviewKey, submittedComments);
      clearSummary(reviewKey, submittedBody);
      toastManager.add({ type: "success", title: verdict.sent });
      onSubmitted();
    } catch {
      toastManager.add({ type: "error", title: "The review could not be submitted" });
    } finally {
      setReviewSubmitting(reviewKey, false);
    }
  };

  // Forgejo requires a summary when requesting changes, even with inline comments.
  const canSubmit = (verdict: PullRequestReviewVerdict) =>
    verdict === "request-changes" && requestChangesSummaryRequired
      ? body.trim().length > 0
      : verdict === "approve" || body.trim().length > 0 || comments.length > 0;

  return (
    <div className="px-4 py-3">
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <span>
          {comments.length === 0
            ? "No line comments yet"
            : `${comments.length} ${comments.length === 1 ? "comment" : "comments"} pending`}
        </span>
        {comments.length > 0 ? (
          <Button size="xs" variant="ghost" disabled={pending} onClick={() => clear(reviewKey)}>
            Discard
          </Button>
        ) : null}
      </div>
      <PullRequestMarkdownField
        environmentId={environmentId}
        onUploadPendingChange={setUploadPending}
        disabled={pending}
        size="sm"
        className="mt-2"
        value={body}
        placeholder={
          requestChangesSummaryRequired && verdicts.includes("request-changes")
            ? "Summarize your review (required to request changes)"
            : "Summarize your review (optional)"
        }
        aria-label="Review summary"
        onChange={(value) => setSummary(reviewKey, value)}
      />
      {editingComments ? (
        <p className="mt-2 text-xs text-muted-foreground" role="status">
          Finish editing pending comments before submitting.
        </p>
      ) : null}
      <div className="mt-2 flex flex-wrap justify-end gap-2">
        {offered.map((verdict) => (
          <Button
            key={verdict.value}
            size="xs"
            variant={verdict.value === "comment" ? "outline" : "default"}
            disabled={pending || uploadPending || editingComments || !canSubmit(verdict.value)}
            onClick={() => void submit(verdict)}
          >
            <span className="flex items-center gap-1.5">
              {verdict.icon}
              {verdict.label}
            </span>
          </Button>
        ))}
      </div>
    </div>
  );
}

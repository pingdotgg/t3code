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
import { Textarea } from "../ui/textarea";
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
  onSubmitted,
}: {
  environmentId: EnvironmentId;
  reference: PullRequestRef;
  verdicts: ReadonlyArray<PullRequestReviewVerdict>;
  onSubmitted: () => void;
}) {
  const [pending, setPending] = useState(false);
  const comments = usePendingReviewComments(reference);
  const reviewKey = pullRequestReviewKey(reference);
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
    if (pending) return;
    const submittedBody = body;
    const submittedComments = comments;
    setPending(true);
    const result = await submitReview({
      environmentId,
      input: {
        ...reference,
        verdict: verdict.value,
        body: submittedBody,
        comments: submittedComments,
      },
    });
    setPending(false);
    if (result._tag === "Failure") {
      // The draft is kept: whatever went wrong, retyping the review is not the answer.
      toastManager.add({ type: "error", title: "The review could not be submitted" });
      return;
    }
    // More remarks may have been added while the host was accepting this snapshot. Leave those,
    // and any summary revised in the meantime, ready for the next review.
    removeComments(
      reviewKey,
      submittedComments.map((comment) => comment.id),
    );
    clearSummary(reviewKey, submittedBody);
    toastManager.add({ type: "success", title: verdict.sent });
    onSubmitted();
  };

  // An approval needs no words; anything else does, unless it carries line comments instead.
  const canSubmit = (verdict: PullRequestReviewVerdict) =>
    verdict === "approve" || body.trim().length > 0 || comments.length > 0;

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
      <Textarea
        size="sm"
        className="mt-2"
        value={body}
        placeholder="Summarize your review (optional)"
        aria-label="Review summary"
        onChange={(event) => setSummary(reviewKey, event.target.value)}
      />
      <div className="mt-2 flex flex-wrap justify-end gap-2">
        {offered.map((verdict) => (
          <Button
            key={verdict.value}
            size="xs"
            variant={verdict.value === "comment" ? "outline" : "default"}
            disabled={pending || !canSubmit(verdict.value)}
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

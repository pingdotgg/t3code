import { useAtomCommand } from "~/state/use-atom-command";
/**
 * The review half of the floating composer: the summary and the verdict that sends it, together
 * with whatever line comments the review is holding. The count of those lives on the composer's
 * trigger and mode toggle, and each pending card can be dropped from the diff, so neither is
 * repeated here. The popover around it belongs to PullRequestComposer.
 */
import type {
  EnvironmentId,
  PullRequestRef,
  PullRequestReviewVerdict,
  SourceControlProviderKind,
} from "@t3tools/contracts";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { CheckIcon, MessageSquareIcon, XCircleIcon } from "lucide-react";
import { useState, type ReactNode, type RefObject } from "react";

import { pullRequestEnvironment } from "~/state/pullRequests";

import { Button } from "../ui/button";
import { Select, SelectItem, SelectPopup, SelectTrigger } from "../ui/select";
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

export function PullRequestReviewForm({
  environmentId,
  reference,
  provider,
  verdicts,
  requestChangesSummaryRequired,
  textareaRef,
  pending,
  onPendingChange,
  onSubmitted,
}: {
  environmentId: EnvironmentId;
  reference: PullRequestRef;
  provider: SourceControlProviderKind;
  verdicts: ReadonlyArray<PullRequestReviewVerdict>;
  requestChangesSummaryRequired: boolean;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  pending: boolean;
  onPendingChange: (pending: boolean) => void;
  onSubmitted: () => void;
}) {
  const [requestedVerdict, setRequestedVerdict] = useState<PullRequestReviewVerdict>("comment");
  const comments = usePendingReviewComments(reference);
  const reviewKey = pullRequestReviewKey(reference);
  // The panel stays mounted while the selected pull request changes. Keeping summaries beside
  // the keyed line-comment drafts makes the selected pull request's body correct on the first
  // render, before an effect could reset state left behind by the previous one.
  const body = usePullRequestReviewStore((store) => store.summaries[reviewKey] ?? "");
  const removeComments = usePullRequestReviewStore((store) => store.removeComments);
  const setSummary = usePullRequestReviewStore((store) => store.setSummary);
  const clearSummary = usePullRequestReviewStore((store) => store.clearSummary);
  const draftRevision = usePullRequestReviewStore((store) => store.revisions[reviewKey]);
  // The diff the Code tab last showed, which is what a review without line comments approves.
  const displayedRevision = usePullRequestReviewStore(
    (store) => store.displayedRevisions[reviewKey],
  );
  const unsettled = usePullRequestReviewStore((store) => store.submissions[reviewKey]);
  const startSubmission = usePullRequestReviewStore((store) => store.startSubmission);
  const finishSubmissionAttempt = usePullRequestReviewStore(
    (store) => store.finishSubmissionAttempt,
  );
  const clearSubmission = usePullRequestReviewStore((store) => store.clearSubmission);
  const submitReview = useAtomCommand(pullRequestEnvironment.submitReview, {
    reportFailure: false,
  });

  const offered = VERDICTS.filter((verdict) => verdicts.includes(verdict.value));
  const selectedVerdict =
    offered.find((verdict) => verdict.value === (unsettled?.verdict ?? requestedVerdict)) ??
    offered[0];

  const submit = async (verdict: (typeof VERDICTS)[number]) => {
    if (pending) return;
    const proposed = {
      verdict: verdict.value,
      body,
      comments,
      ...((comments.length > 0 ? draftRevision : displayedRevision) === undefined
        ? {}
        : { revision: comments.length > 0 ? draftRevision! : displayedRevision! }),
    };
    // GitCafe reviews carry a stable request id, so a submission whose outcome is unknown is
    // held and only ever retried as-is rather than replaced by an edited one.
    const started = provider === "gitcafe" ? startSubmission(reviewKey, proposed) : undefined;
    if (provider === "gitcafe" && started === undefined) return;
    const submission = started?.submission ?? { ...proposed, id: undefined };
    const submittedBody = submission.body;
    const submittedComments = submission.comments;
    const reviewRevision = submission.revision;
    const requestId = submission.id;
    onPendingChange(true);
    const result = await submitReview({
      environmentId,
      input: {
        ...reference,
        ...(provider === "gitcafe" && reviewRevision !== undefined ? { reviewRevision } : {}),
        ...(requestId === undefined ? {} : { requestId }),
        verdict: submission.verdict,
        body: submittedBody,
        comments: submittedComments,
      },
    });
    onPendingChange(false);
    if (result._tag === "Failure") {
      // The draft is kept: whatever went wrong, retyping the review is not the answer.
      const failure = squashAtomCommandFailure(result);
      if (requestId !== undefined) {
        finishSubmissionAttempt(reviewKey, requestId);
        if (
          started?.firstAttempt === true &&
          typeof failure === "object" &&
          failure !== null &&
          "notDispatched" in failure &&
          failure.notDispatched === true
        )
          clearSubmission(reviewKey, requestId);
      }
      const detail =
        failure instanceof Error
          ? failure.message
          : typeof failure === "string"
            ? failure
            : "Retry the preserved submission or follow the provider's recovery instructions.";
      toastManager.add({
        type: "error",
        title: "The review could not be submitted",
        description: detail,
      });
      return;
    }
    // More remarks may have been added while the host was accepting this snapshot. Leave those,
    // and any summary revised in the meantime, ready for the next review.
    removeComments(
      reviewKey,
      submittedComments.map((comment) => comment.id),
    );
    clearSummary(reviewKey, submittedBody);
    if (requestId !== undefined) clearSubmission(reviewKey, requestId);
    toastManager.add({
      type: "success",
      title: VERDICTS.find((candidate) => candidate.value === submission.verdict)?.sent,
    });
    onSubmitted();
  };

  // Forgejo requires a summary when requesting changes, even with inline comments.
  // GitCafe reviews name the exact diff they cover, which exists once the Code tab has shown it.
  const needsReviewedDiff =
    provider === "gitcafe" &&
    unsettled === undefined &&
    (comments.length > 0 ? draftRevision : displayedRevision) === undefined;
  const canSubmit = (verdict: PullRequestReviewVerdict) =>
    !needsReviewedDiff &&
    (verdict === "request-changes" && requestChangesSummaryRequired
      ? body.trim().length > 0
      : verdict === "approve" || body.trim().length > 0 || comments.length > 0);

  return (
    <>
      <Textarea
        ref={textareaRef}
        rows={3}
        value={body}
        placeholder={
          requestChangesSummaryRequired && verdicts.includes("request-changes")
            ? "Summarize your review (required to request changes)"
            : "Summarize your review (optional)"
        }
        aria-label="Review summary"
        onChange={(event) => setSummary(reviewKey, event.target.value)}
      />
      {needsReviewedDiff ? (
        <p className="mt-2 text-xs text-muted-foreground">
          Open the Code tab first, so the review covers the diff you read.
        </p>
      ) : unsettled !== undefined ? (
        <p className="mt-2 text-xs text-muted-foreground">
          The last review may already be on GitCafe. Retry sends it unchanged; discard drops it here
          only.
        </p>
      ) : null}
      <div className="mt-2 flex justify-between gap-2">
        <Select
          value={selectedVerdict?.value ?? null}
          disabled={pending || unsettled !== undefined}
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
        {unsettled !== undefined ? (
          <div className="flex gap-1">
            <Button
              size="xs"
              variant="ghost"
              disabled={pending}
              onClick={() => clearSubmission(reviewKey, unsettled.id)}
            >
              Discard
            </Button>
            <Button
              size="xs"
              disabled={pending}
              onClick={() =>
                void submit(VERDICTS.find((candidate) => candidate.value === unsettled.verdict)!)
              }
            >
              {pending ? "Submitting..." : "Retry previous submission"}
            </Button>
          </div>
        ) : (
          <Button
            size="xs"
            disabled={pending || selectedVerdict === undefined || !canSubmit(selectedVerdict.value)}
            onClick={() => {
              if (selectedVerdict !== undefined) void submit(selectedVerdict);
            }}
          >
            {pending ? "Submitting..." : "Submit review"}
          </Button>
        )}
      </div>
    </>
  );
}

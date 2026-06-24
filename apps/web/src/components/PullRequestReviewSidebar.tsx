import type { EnvironmentId, PullRequestReviewEvent } from "@t3tools/contracts";
import { isAtomCommandInterrupted, squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  BotIcon,
  CheckCircle2Icon,
  CircleDashedIcon,
  FolderGit2Icon,
  GitBranchIcon,
  MessageSquareIcon,
  ShieldCheckIcon,
  XCircleIcon,
} from "lucide-react";
import { useCallback, useState } from "react";

import { gitPrEnvironment, refreshAllPullRequestData } from "~/state/gitPr";
import { useAtomCommand } from "~/state/use-atom-command";
import { useEnvironmentQuery } from "~/state/query";
import { cn } from "~/lib/utils";
import { Button } from "./ui/button";
import { Spinner } from "./ui/spinner";
import { toastManager } from "./ui/toast";

interface PullRequestReviewSidebarProps {
  environmentId: EnvironmentId | null;
  cwd: string | null;
  prNumber: number;
  onReviewWithAgent?: (() => void) | undefined;
  isAgentReviewPending?: boolean | undefined;
  onCheckout?: ((mode: "local" | "worktree") => void) | undefined;
  isCheckoutPending?: "local" | "worktree" | null | undefined;
}

function mergeableColor(value: string): string {
  if (value === "MERGEABLE") return "text-green-500";
  if (value === "CONFLICTING") return "text-red-500";
  return "text-amber-500";
}

function reviewDecisionColor(value: string): string {
  if (value === "APPROVED") return "text-green-500";
  if (value === "CHANGES_REQUESTED") return "text-red-500";
  return "text-amber-500";
}

function reviewDecisionLabel(value: string): string {
  if (value === "APPROVED") return "Approved";
  if (value === "CHANGES_REQUESTED") return "Changes requested";
  if (value === "REVIEW_REQUIRED") return "Review required";
  return value;
}

function mergeableLabel(value: string): string {
  if (value === "MERGEABLE") return "Mergeable";
  if (value === "CONFLICTING") return "Conflicting";
  return "Unknown";
}

export function PullRequestReviewSidebar({
  environmentId,
  cwd,
  prNumber,
  onReviewWithAgent,
  isAgentReviewPending,
  onCheckout,
  isCheckoutPending,
}: PullRequestReviewSidebarProps) {
  const [reviewBody, setReviewBody] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);

  const detailQuery = useEnvironmentQuery(
    environmentId !== null && cwd !== null
      ? gitPrEnvironment.pullRequestDetail({ environmentId, input: { cwd, prNumber } })
      : null,
  );

  const submitReview = useAtomCommand(gitPrEnvironment.submitPullRequestReview, {
    reportFailure: false,
  });

  const handleSubmitReview = useCallback(
    async (event: PullRequestReviewEvent) => {
      if (environmentId === null || cwd === null) return;
      const trimmed = reviewBody.trim();
      setIsSubmitting(true);
      const result = await submitReview({
        environmentId,
        input: { cwd, prNumber, event, ...(trimmed ? { body: trimmed } : {}) },
      });
      setIsSubmitting(false);
      if (result._tag === "Success") {
        setReviewBody("");
        refreshAllPullRequestData({ environmentId, cwd, prNumber });
        toastManager.add({
          type: "success",
          title: "Review submitted",
          description:
            event === "APPROVE"
              ? "Pull request approved"
              : event === "REQUEST_CHANGES"
                ? "Changes requested"
                : "Comment posted",
        });
        return;
      }
      if (!isAtomCommandInterrupted(result)) {
        const failure = squashAtomCommandFailure(result);
        toastManager.add({
          type: "error",
          title: "Failed to submit review",
          description: failure instanceof Error ? failure.message : "An error occurred.",
        });
      }
    },
    [reviewBody, submitReview, environmentId, cwd, prNumber],
  );

  const detail = detailQuery.data;

  const checksPass = detail?.checks.filter((c) => c.status === "pass").length ?? 0;
  const checksFail = detail?.checks.filter((c) => c.status === "fail").length ?? 0;
  const checksPending = detail?.checks.filter((c) => c.status === "pending").length ?? 0;

  return (
    <aside className="flex h-full w-64 shrink-0 flex-col gap-4 overflow-y-auto border-l border-border/70 bg-background p-3">
      {/* Review submission */}
      <section className="space-y-2">
        <textarea
          value={reviewBody}
          onChange={(e) => setReviewBody(e.target.value)}
          rows={2}
          placeholder="Leave a review summary..."
          disabled={isSubmitting}
          className="w-full resize-none rounded-md border border-border/70 bg-background p-2 text-xs outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/20"
        />
        <div className="flex flex-col gap-1.5">
          <Button
            type="button"
            size="sm"
            className="w-full"
            onClick={() => void handleSubmitReview("APPROVE")}
            disabled={isSubmitting}
          >
            {isSubmitting ? (
              <Spinner className="size-3.5" />
            ) : (
              <CheckCircle2Icon className="size-3.5" aria-hidden="true" />
            )}
            Approve
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="w-full"
            onClick={() => void handleSubmitReview("COMMENT")}
            disabled={isSubmitting}
          >
            <MessageSquareIcon className="size-3.5" aria-hidden="true" />
            Comment
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="w-full"
            onClick={() => void handleSubmitReview("REQUEST_CHANGES")}
            disabled={isSubmitting}
          >
            <XCircleIcon className="size-3.5" aria-hidden="true" />
            Request changes
          </Button>
        </div>
      </section>

      {/* Merge readiness */}
      <section className="space-y-2">
        <h3 className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
          Merge readiness
        </h3>
        {detailQuery.isLoading ? (
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Spinner className="size-3.5" />
            Loading...
          </div>
        ) : detail ? (
          <div className="space-y-1.5 text-xs">
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">Mergeable</span>
              <span className={cn("font-medium", mergeableColor(detail.mergeable))}>
                {mergeableLabel(detail.mergeable)}
              </span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">Review</span>
              <span className={cn("font-medium", reviewDecisionColor(detail.reviewDecision))}>
                {reviewDecisionLabel(detail.reviewDecision)}
              </span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">Checks</span>
              <span className="flex items-center gap-1.5 font-medium">
                {checksPass > 0 && (
                  <span className="flex items-center gap-0.5 text-green-500">
                    <ShieldCheckIcon className="size-3" aria-hidden="true" />
                    {checksPass}
                  </span>
                )}
                {checksFail > 0 && (
                  <span className="flex items-center gap-0.5 text-red-500">
                    <XCircleIcon className="size-3" aria-hidden="true" />
                    {checksFail}
                  </span>
                )}
                {checksPending > 0 && (
                  <span className="flex items-center gap-0.5 text-amber-500">
                    <CircleDashedIcon className="size-3" aria-hidden="true" />
                    {checksPending}
                  </span>
                )}
                {checksPass === 0 && checksFail === 0 && checksPending === 0 && (
                  <span className="text-muted-foreground">None</span>
                )}
              </span>
            </div>
          </div>
        ) : null}
      </section>

      {/* Agent & Workspace */}
      <section className="space-y-2">
        <h3 className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
          Workspace
        </h3>
        <div className="flex flex-col gap-1.5">
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="justify-start"
            onClick={onReviewWithAgent}
            disabled={isAgentReviewPending || !onReviewWithAgent}
          >
            {isAgentReviewPending ? (
              <Spinner className="size-3.5" />
            ) : (
              <BotIcon className="size-3.5" aria-hidden="true" />
            )}
            Review with agent
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="justify-start"
            onClick={() => onCheckout?.("local")}
            disabled={!!isCheckoutPending || !onCheckout}
          >
            {isCheckoutPending === "local" ? (
              <Spinner className="size-3.5" />
            ) : (
              <GitBranchIcon className="size-3.5" aria-hidden="true" />
            )}
            Checkout
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="justify-start"
            onClick={() => onCheckout?.("worktree")}
            disabled={!!isCheckoutPending || !onCheckout}
          >
            {isCheckoutPending === "worktree" ? (
              <Spinner className="size-3.5" />
            ) : (
              <FolderGit2Icon className="size-3.5" aria-hidden="true" />
            )}
            New worktree
          </Button>
        </div>
      </section>
    </aside>
  );
}

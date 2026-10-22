import { useAtomValue } from "@effect/atom-react";
import { azureVoteLabels } from "@t3tools/client-runtime/azure-devops-pull-request-actions";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  AzureDevOpsReviewVote,
  type EnvironmentId,
  type PullRequestDetail,
  type PullRequestRef,
  type PullRequestReviewVerdict,
} from "@t3tools/contracts";
import { CheckIcon, ChevronDownIcon } from "lucide-react";
import { useRef, useState } from "react";
import { pullRequestEnvironment } from "~/state/pullRequests";
import { useAtomCommand } from "~/state/use-atom-command";
import { Button } from "../ui/button";
import { Menu, MenuPopup, MenuTrigger } from "../ui/menu";
import { toastManager } from "../ui/toast";
import {
  PullRequestPermissionButton,
  PullRequestPermissionHint,
  PullRequestPermissionMenuItem,
} from "./PullRequestPermissionButton";
import { readableFailure } from "./pullRequestDetail.logic";

const reviewLabels: Record<PullRequestReviewVerdict, string> = {
  approve: "Approve",
  "request-changes": "Request changes",
  comment: "Comment",
};

export function PullRequestReviewButton({
  environmentId,
  reference,
  detail,
  actionPending,
  onReview,
  onActed,
}: {
  environmentId: EnvironmentId;
  reference: PullRequestRef;
  detail: PullRequestDetail;
  actionPending: boolean;
  onReview: (verdict: PullRequestReviewVerdict) => void;
  onActed: () => void;
}) {
  const azure = detail.provider === "azure-devops" && detail.capabilities.hostActions === true;
  const allowed = useAtomValue(
    (azure
      ? pullRequestEnvironment.runHostAction
      : pullRequestEnvironment.submitReview
    ).permissionAtom(environmentId),
  );
  const run = useAtomCommand(pullRequestEnvironment.runHostAction, { reportFailure: false });
  const pending = useRef(false);
  const [busy, setBusy] = useState(false);
  if (
    detail.state !== "open" ||
    (azure && detail.isDraft) ||
    (!azure &&
      (detail.provider !== "github" || !detail.capabilities.review.verdicts.includes("approve")))
  )
    return null;

  const reason =
    detail.viewerPermissions.deniedActions?.vote ??
    (!allowed ? "This connection does not allow pull request reviews." : undefined);
  const disabled = actionPending || busy;
  const verdictReason = (verdict: PullRequestReviewVerdict) =>
    reason ??
    (!detail.viewerPermissions.verdicts.includes(verdict)
      ? detail.viewer === detail.author?.login && verdict !== "comment"
        ? "You cannot approve or request changes on your own pull request."
        : "You do not have permission to submit this review."
      : undefined);
  const vote = async (value: AzureDevOpsReviewVote) => {
    if (reason || disabled || pending.current) return;
    pending.current = true;
    setBusy(true);
    await Promise.resolve()
      .then(() =>
        run({
          environmentId,
          input: { ...reference, action: { type: "vote", vote: value } },
        }),
      )
      .then((result) => {
        if (result._tag === "Failure") throw squashAtomCommandFailure(result);
        toastManager.add({ type: "success", title: result.value.message });
        onActed();
      })
      .catch((cause: unknown) => {
        toastManager.add({
          type: "error",
          title: readableFailure(cause, "Your review could not be submitted."),
        });
      })
      .finally(() => {
        pending.current = false;
        setBusy(false);
      });
  };
  const review = (verdict: PullRequestReviewVerdict) => {
    if (!disabled && !verdictReason(verdict)) onReview(verdict);
  };
  return (
    <div role="group" aria-label="Review pull request" className="flex items-center">
      <PullRequestPermissionButton
        size="xs"
        variant="outline"
        groupPosition="start"
        reason={azure ? reason : verdictReason("approve")}
        disabled={disabled}
        aria-label={busy ? "Submitting review" : "Approve pull request"}
        onClick={() => (azure ? void vote("approve") : review("approve"))}
      >
        <CheckIcon className="size-3.5" />
        <span className="@max-[30rem]/pr-header:hidden">{busy ? "Submitting…" : "Approve"}</span>
      </PullRequestPermissionButton>
      <Menu>
        <PullRequestPermissionHint reason={reason}>
          <MenuTrigger
            disabled={disabled || Boolean(reason)}
            render={<Button size="icon-xs" variant="outline" groupPosition="end" />}
            aria-label="Other review options"
          >
            <ChevronDownIcon className="size-3" />
          </MenuTrigger>
        </PullRequestPermissionHint>
        <MenuPopup align="end">
          {azure
            ? AzureDevOpsReviewVote.literals.map((value) => (
                <PullRequestPermissionMenuItem
                  key={value}
                  reason={reason}
                  disabled={disabled}
                  onClick={() => void vote(value)}
                >
                  {azureVoteLabels[value]}
                </PullRequestPermissionMenuItem>
              ))
            : detail.capabilities.review.verdicts.map((value) => (
                <PullRequestPermissionMenuItem
                  key={value}
                  reason={verdictReason(value)}
                  disabled={disabled}
                  onClick={() => review(value)}
                >
                  {reviewLabels[value]}
                </PullRequestPermissionMenuItem>
              ))}
        </MenuPopup>
      </Menu>
    </div>
  );
}

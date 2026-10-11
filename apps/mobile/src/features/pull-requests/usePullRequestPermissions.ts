import { useAtomValue } from "@effect/atom-react";
import type { PullRequestDetail } from "@t3tools/contracts";
import { composerPullRequests } from "../../state/pull-requests";
import { pullRequestTarget, type PullRequestParams } from "./usePullRequestDiff";

export function usePullRequestPermissions(params: PullRequestParams, pr: PullRequestDetail | null) {
  const { environmentId } = pullRequestTarget(params);
  const canWrite = useAtomValue(composerPullRequests.runAction.permissionAtom(environmentId));
  const canComment = useAtomValue(composerPullRequests.comment.permissionAtom(environmentId));
  const canReview = useAtomValue(composerPullRequests.submitReview.permissionAtom(environmentId));
  const canReply = useAtomValue(composerPullRequests.replyToThread.permissionAtom(environmentId));
  const canResolve = useAtomValue(
    composerPullRequests.setThreadResolution.permissionAtom(environmentId),
  );
  return {
    canInlineComment:
      canReview &&
      pr?.state === "open" &&
      pr.capabilities.review.inlineComment &&
      pr.viewerPermissions.comment &&
      pr.capabilities.review.verdicts.some((verdict) =>
        pr.viewerPermissions.verdicts.includes(verdict),
      ),
    canReply: canReply && pr?.capabilities.review.reply === true && pr.viewerPermissions.comment,
    canResolve:
      canResolve && pr?.capabilities.review.resolve === true && pr.viewerPermissions.resolve,
    canWrite,
    canComment: canComment && pr?.capabilities.comment === true && pr.viewerPermissions.comment,
    verdicts:
      canReview && pr?.state === "open"
        ? pr.capabilities.review.verdicts.filter((verdict) =>
            pr.viewerPermissions.verdicts.includes(verdict),
          )
        : [],
  };
}

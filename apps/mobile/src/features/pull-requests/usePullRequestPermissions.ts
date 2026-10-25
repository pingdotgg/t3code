import { useAtomValue } from "@effect/atom-react";
import {
  canEditPullRequestChangeRequest,
  canEditPullRequestComment,
} from "@t3tools/client-runtime/pull-request-editing";
import type { PullRequestComment, PullRequestDetail } from "@t3tools/contracts";
import { usePullRequestConnected } from "./usePullRequestConnected";
import { composerPullRequests } from "../../state/pull-requests";
import { pullRequestTarget, type PullRequestParams } from "./usePullRequestDiff";

export function usePullRequestPermissions(params: PullRequestParams, pr: PullRequestDetail | null) {
  const { environmentId } = pullRequestTarget(params);
  const connected = usePullRequestConnected(environmentId);
  const canWrite = useAtomValue(composerPullRequests.runAction.permissionAtom(environmentId));
  const canComment = useAtomValue(composerPullRequests.comment.permissionAtom(environmentId));
  const canReview = useAtomValue(composerPullRequests.submitReview.permissionAtom(environmentId));
  const canReply = useAtomValue(composerPullRequests.replyToThread.permissionAtom(environmentId));
  const canResolve = useAtomValue(
    composerPullRequests.setThreadResolution.permissionAtom(environmentId),
  );
  const canUpdate = useAtomValue(composerPullRequests.update.permissionAtom(environmentId));
  const canUpdateComment = useAtomValue(
    composerPullRequests.updateComment.permissionAtom(environmentId),
  );
  const canSetReaction = useAtomValue(
    composerPullRequests.setReaction.permissionAtom(environmentId),
  );
  return {
    connected,
    canInlineComment:
      connected &&
      canReview &&
      pr?.state === "open" &&
      pr.capabilities.review.inlineComment &&
      pr.viewerPermissions.comment &&
      pr.capabilities.review.verdicts.some((verdict) =>
        pr.viewerPermissions.verdicts.includes(verdict),
      ),
    canReply:
      connected &&
      canReply &&
      pr?.capabilities.review.reply === true &&
      pr.viewerPermissions.comment,
    canResolve:
      connected &&
      canResolve &&
      pr?.capabilities.review.resolve === true &&
      pr.viewerPermissions.resolve,
    canWrite: connected && canWrite,
    canEditChangeRequest:
      connected && canUpdate && pr !== null && canEditPullRequestChangeRequest(pr),
    canEditComment: (comment: Pick<PullRequestComment, "author" | "canEdit" | "kind">) =>
      connected && canUpdateComment && pr !== null && canEditPullRequestComment(pr, comment),
    canReact: connected && canSetReaction && pr?.capabilities.reactions === true,
    canComment:
      connected && canComment && pr?.capabilities.comment === true && pr.viewerPermissions.comment,
    verdicts:
      connected && canReview && pr?.state === "open"
        ? pr.capabilities.review.verdicts.filter((verdict) =>
            pr.viewerPermissions.verdicts.includes(verdict),
          )
        : [],
  };
}

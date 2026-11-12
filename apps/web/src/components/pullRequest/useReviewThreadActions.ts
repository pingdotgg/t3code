import { useAtomValue } from "@effect/atom-react";
import type {
  EnvironmentId,
  PullRequestDetailView,
  PullRequestRef,
  PullRequestReviewThread,
  PullRequestThreadComment,
} from "@t3tools/contracts";
import {
  reviewThreadReplyTarget,
  canEditPullRequestComment,
  canResolvePullRequestThread,
} from "@t3tools/client-runtime/review-editing";
import { useRef, useState } from "react";
import { pullRequestEnvironment } from "~/state/pullRequests";
import { useAtomCommand } from "~/state/use-atom-command";
import { toastManager } from "../ui/toast";

/** The same host operations for a review conversation wherever it is shown. */
export function useReviewThreadActions(
  environmentId: EnvironmentId,
  reference: PullRequestRef,
  detail: Pick<PullRequestDetailView, "capabilities" | "viewerPermissions" | "author" | "viewer">,
  onRefresh: () => void,
) {
  const [pending, setPending] = useState(false);
  const sending = useRef(false);
  const canReply = useAtomValue(pullRequestEnvironment.replyToThread.permissionAtom(environmentId));
  const canResolve = useAtomValue(
    pullRequestEnvironment.setThreadResolution.permissionAtom(environmentId),
  );
  const canEdit = useAtomValue(pullRequestEnvironment.updateComment.permissionAtom(environmentId));
  const reply = useAtomCommand(pullRequestEnvironment.replyToThread, { reportFailure: false });
  const resolve = useAtomCommand(pullRequestEnvironment.setThreadResolution, {
    reportFailure: false,
  });
  const edit = useAtomCommand(pullRequestEnvironment.updateComment, { reportFailure: false });
  const load = useAtomCommand(pullRequestEnvironment.threadComments, { reportFailure: false });
  const run = async (label: string, command: () => Promise<{ readonly _tag: string }>) => {
    if (sending.current) return false;
    sending.current = true;
    setPending(true);
    return await (async () => {
      if ((await command())._tag === "Failure") {
        toastManager.add({ type: "error", title: label });
        return false;
      }
      onRefresh();
      return true;
    })().finally(async () => {
      sending.current = false;
      setPending(false);
    });
  };
  return (thread: PullRequestReviewThread) => ({
    pending,
    canReply: canReply && detail.capabilities.review.reply && detail.viewerPermissions.comment,
    canResolve:
      canResolve &&
      detail.capabilities.review.resolve &&
      canResolvePullRequestThread(detail, thread) &&
      !thread.comments.some((comment) => comment.pendingReviewId),
    canEditComment: (comment: PullRequestThreadComment) =>
      canEdit &&
      canEditPullRequestComment(detail, {
        author: comment.author,
        kind: "review-comment",
        canEdit: comment.canEdit,
      }),
    onReply: (body: string) =>
      run("Reply could not be posted", () =>
        reply({ environmentId, input: { ...reference, ...reviewThreadReplyTarget(thread), body } }),
      ),
    onEditComment: (commentId: string, body: string) =>
      run("The comment could not be saved", () =>
        edit({ environmentId, input: { ...reference, commentId, kind: "review-comment", body } }),
      ),
    onToggleResolved: () => {
      // Resolution is projected across every view by the shared command. It may be queued
      // without locking replies or other discussions while the host catches up.
      void resolve({
        environmentId,
        input: { ...reference, threadId: thread.id, resolved: !thread.isResolved },
      }).then((result) => {
        if (result._tag === "Failure") {
          toastManager.add({ type: "error", title: "The conversation could not be updated" });
        }
      });
    },
    onLoadMore: async (cursor: string) => {
      const result = await load({
        environmentId,
        input: { ...reference, threadId: thread.id, cursor },
      });
      if (result._tag === "Failure") {
        toastManager.add({ type: "error", title: "More comments could not be loaded" });
        return null;
      }
      return result.value;
    },
  });
}

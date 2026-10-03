import type {
  EnvironmentId,
  PullRequestDetailView,
  PullRequestRef,
  PullRequestReviewThread,
} from "@t3tools/contracts";
import { useState } from "react";

import { useAtomCommand } from "~/state/use-atom-command";
import { pullRequestEnvironment } from "~/state/pullRequests";

import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";

/**
 * Resolve or unresolve a review thread from a conversation entry rather than from its line in the
 * Code tab. Callers render it on the thread's first comment only, so a thread with five replies
 * offers one control, not five. Renders nothing where the host or this account cannot resolve.
 */
export function PullRequestResolveThreadButton({
  environmentId,
  reference,
  detail,
  thread,
  className,
  onRefresh,
}: {
  environmentId: EnvironmentId;
  reference: PullRequestRef;
  detail: PullRequestDetailView;
  thread: PullRequestReviewThread;
  className?: string | undefined;
  onRefresh: () => void;
}) {
  const [pending, setPending] = useState(false);
  const setThreadResolution = useAtomCommand(pullRequestEnvironment.setThreadResolution, {
    reportFailure: false,
  });
  if (!detail.capabilities.review.resolve || !detail.viewerPermissions.resolve) return null;

  const toggle = async () => {
    if (pending) return;
    setPending(true);
    const result = await setThreadResolution({
      environmentId,
      input: { ...reference, threadId: thread.id, resolved: !thread.isResolved },
    });
    setPending(false);
    if (result._tag === "Failure") {
      toastManager.add({ type: "error", title: "The conversation could not be updated" });
      return;
    }
    onRefresh();
  };

  return (
    <Button
      size="xs"
      variant="ghost"
      className={className}
      disabled={pending}
      onClick={() => void toggle()}
    >
      {thread.isResolved ? "Unresolve" : "Resolve"}
    </Button>
  );
}

/** The thread a comment opens, or null for replies and for remarks on no thread at all. */
export function pullRequestThreadOpenedBy(
  threadByCommentId: ReadonlyMap<string, PullRequestReviewThread>,
  commentId: string,
): PullRequestReviewThread | null {
  const thread = threadByCommentId.get(commentId);
  return thread?.comments[0]?.id === commentId ? thread : null;
}

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
  // The state asked for, held until the thread shows it so the button stays disabled through the
  // refetch instead of re-enabling on the old label. `sent` is the thread as it was when the update
  // succeeded: any refreshed copy also ends the wait, so a refetch that still reports the old
  // state cannot leave the button disabled.
  const [requested, setRequested] = useState<{
    readonly resolved: boolean;
    readonly sent: PullRequestReviewThread | null;
  } | null>(null);
  if (
    requested !== null &&
    (thread.isResolved === requested.resolved ||
      (requested.sent !== null && thread !== requested.sent))
  ) {
    setRequested(null);
  }
  const pending = requested !== null;
  const setThreadResolution = useAtomCommand(pullRequestEnvironment.setThreadResolution, {
    reportFailure: false,
  });
  if (!detail.capabilities.review.resolve || !detail.viewerPermissions.resolve) return null;

  const toggle = async () => {
    if (pending) return;
    const resolved = !thread.isResolved;
    setRequested({ resolved, sent: null });
    const result = await setThreadResolution({
      environmentId,
      input: { ...reference, threadId: thread.id, resolved },
    });
    if (result._tag === "Failure") {
      setRequested(null);
      toastManager.add({ type: "error", title: "The conversation could not be updated" });
      return;
    }
    setRequested({ resolved, sent: thread });
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

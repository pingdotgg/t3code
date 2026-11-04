import type {
  EnvironmentId,
  PullRequestDetailView,
  PullRequestRef,
  PullRequestReviewThread,
} from "@t3tools/contracts";
import { canResolvePullRequestThread } from "@t3tools/client-runtime/pull-request-editing";
import { useState } from "react";

import { pullRequestEnvironment } from "~/state/pullRequests";
import { useAtomCommand } from "~/state/use-atom-command";

import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";

/**
 * Resolves or unresolves a thread from the conversation rather than from its line in the Code tab,
 * which a thread on the change request as a whole does not have. Callers put it on the thread's
 * first comment only. Renders nothing where the host or this account cannot resolve the thread.
 */
export function PullRequestResolveThreadButton({
  environmentId,
  reference,
  detail,
  thread,
  onRefresh,
}: {
  environmentId: EnvironmentId;
  reference: PullRequestRef;
  detail: PullRequestDetailView;
  thread: Pick<PullRequestReviewThread, "id" | "isResolved" | "canResolve">;
  onRefresh: () => void;
}) {
  // Held until a refreshed detail arrives, so the button does not re-enable on the old label.
  const [sent, setSent] = useState<PullRequestDetailView | "pending" | null>(null);
  if (sent !== null && sent !== "pending" && sent !== detail) setSent(null);
  const setThreadResolution = useAtomCommand(pullRequestEnvironment.setThreadResolution, {
    reportFailure: false,
  });
  if (!detail.capabilities.review.resolve || !canResolvePullRequestThread(detail, thread)) {
    return null;
  }

  const toggle = async () => {
    setSent("pending");
    const result = await setThreadResolution({
      environmentId,
      input: { ...reference, threadId: thread.id, resolved: !thread.isResolved },
    });
    if (result._tag === "Failure") {
      setSent(null);
      toastManager.add({ type: "error", title: "The conversation could not be updated" });
      return;
    }
    setSent(detail);
    onRefresh();
  };

  return (
    <Button
      size="xs"
      variant="ghost"
      className="shrink-0"
      disabled={sent !== null}
      onClick={() => void toggle()}
    >
      {thread.isResolved ? "Unresolve" : "Resolve"}
    </Button>
  );
}

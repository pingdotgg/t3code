import type {
  EnvironmentId,
  PullRequestDetailView,
  PullRequestRef,
  PullRequestConversationThread,
} from "@t3tools/contracts";
import { canResolvePullRequestThread } from "@t3tools/client-runtime/pull-request-editing";
import { useState } from "react";

import { pullRequestEnvironment } from "~/state/pullRequests";
import { useAtomCommand } from "~/state/use-atom-command";

import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";

/**
 * Resolves or unresolves a thread from the conversation, so threads without a diff line (such as
 * GitLab overview threads) can be resolved too. Callers put it on the thread's first comment only.
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
  thread: Pick<PullRequestConversationThread, "id" | "isResolved" | "canResolve">;
  onRefresh: () => void;
}) {
  const [pending, setPending] = useState(false);
  const setThreadResolution = useAtomCommand(pullRequestEnvironment.setThreadResolution, {
    reportFailure: false,
  });
  if (!detail.capabilities.review.resolve || !canResolvePullRequestThread(detail, thread)) {
    return null;
  }

  const toggle = async () => {
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
      className="shrink-0"
      disabled={pending}
      onClick={() => void toggle()}
    >
      {thread.isResolved ? "Unresolve" : "Resolve"}
    </Button>
  );
}

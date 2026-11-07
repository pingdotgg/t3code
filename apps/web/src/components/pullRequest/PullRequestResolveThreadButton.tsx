import type {
  EnvironmentId,
  PullRequestDetailView,
  PullRequestRef,
  PullRequestReviewThread,
} from "@t3tools/contracts";
import { canResolvePullRequestThread } from "@t3tools/client-runtime/pull-request-editing";
import { useSyncExternalStore } from "react";

import { pullRequestEnvironment } from "~/state/pullRequests";
import { useAtomCommand } from "~/state/use-atom-command";

import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";

// Weak so a snapshot is freed once refreshed activity replaces it in `detail`.
type Sent = WeakRef<PullRequestDetailView["reviewThreads"]> | "pending";

// Outlives the button, which unmounts when its thread collapses, so reopening it mid-request
// cannot send a second one.
const sentByThread = new Map<string, Sent>();
const sentListeners = new Set<() => void>();
const subscribeSent = (listener: () => void) => {
  sentListeners.add(listener);
  return () => sentListeners.delete(listener);
};
const setSentFor = (key: string, sent: Sent | null) => {
  if (sent === null) sentByThread.delete(key);
  else sentByThread.set(key, sent);
  for (const listener of sentListeners) listener();
};

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
  // Held until refreshed activity arrives: `detail` is rebuilt whenever the core detail reloads,
  // which can land before activity does and would re-enable the button on the old label.
  const key = `${environmentId}:${thread.id}`;
  const sent = useSyncExternalStore(subscribeSent, () => sentByThread.get(key));
  const waiting = sent === "pending" || sent?.deref() === detail.reviewThreads;
  const setThreadResolution = useAtomCommand(pullRequestEnvironment.setThreadResolution, {
    reportFailure: false,
  });
  if (!detail.capabilities.review.resolve || !canResolvePullRequestThread(detail, thread)) {
    return null;
  }

  const toggle = async () => {
    setSentFor(key, "pending");
    const result = await setThreadResolution({
      environmentId,
      input: { ...reference, threadId: thread.id, resolved: !thread.isResolved },
    });
    if (result._tag === "Failure") {
      setSentFor(key, null);
      toastManager.add({ type: "error", title: "The conversation could not be updated" });
      return;
    }
    setSentFor(key, new WeakRef(detail.reviewThreads));
    onRefresh();
  };

  return (
    <Button
      size="xs"
      variant="ghost"
      className="shrink-0"
      disabled={waiting}
      onClick={() => void toggle()}
    >
      {thread.isResolved ? "Unresolve" : "Resolve"}
    </Button>
  );
}

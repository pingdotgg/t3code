import type {
  OrchestrationV2AppThread,
  ThreadPullRequestLink,
  ThreadPullRequestSnapshot,
} from "@t3tools/contracts";
import { snoozablePullRequests } from "@t3tools/shared/threadPullRequests";
import * as DateTime from "effect/DateTime";

import { threadPullRequestKeysEqual } from "../sourceControl/threadPullRequests.ts";

function pullRequestUpdated(
  before: ThreadPullRequestSnapshot | null,
  after: ThreadPullRequestSnapshot,
  watched: boolean,
): boolean {
  const reviewed =
    (after.reviewDecision === "approved" || after.reviewDecision === "changes-requested") &&
    after.reviewDecision !== before?.reviewDecision;
  const conflicted = after.mergeability === "conflicting" && before?.mergeability !== "conflicting";
  // A watching agent answers its own checks; the user hears if it gets stuck.
  const checksFinished =
    !watched &&
    (before?.checksState == null || before.checksState === "pending") &&
    (after.checksState === "passing" || after.checksState === "failing");
  return reviewed || conflicted || checksFinished;
}

/**
 * Ends a pull request snooze now, as its timer would, when a sync brings a review verdict, a
 * merge conflict or finished checks, or leaves no pull request open.
 */
export function wakePullRequestSnooze<
  Thread extends Pick<OrchestrationV2AppThread, "snoozedUntil" | "snoozeUntilPullRequest">,
>(
  before: ReadonlyArray<ThreadPullRequestLink>,
  thread: Thread,
  after: ReadonlyArray<ThreadPullRequestLink>,
  now: DateTime.Utc,
): Thread {
  if (thread.snoozeUntilPullRequest !== true || thread.snoozedUntil == null) return thread;
  if (DateTime.toEpochMillis(thread.snoozedUntil) <= DateTime.toEpochMillis(now)) return thread;
  const open = snoozablePullRequests(after);
  const wake =
    open.length === 0 ||
    open.some((link) => {
      // One linked after the snooze has no baseline; one linked but unread before it does.
      const previous = before.find((candidate) => threadPullRequestKeysEqual(candidate, link));
      return (
        previous !== undefined &&
        link.snapshot !== null &&
        pullRequestUpdated(previous.snapshot, link.snapshot, link.watch !== undefined)
      );
    });
  return wake ? { ...thread, snoozedUntil: now, snoozeUntilPullRequest: false } : thread;
}

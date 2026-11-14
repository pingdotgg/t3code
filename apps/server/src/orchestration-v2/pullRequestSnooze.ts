import type {
  OrchestrationV2AppThread,
  PullRequestSnoozeTrigger,
  ThreadPullRequestLink,
  ThreadPullRequestSnapshot,
} from "@t3tools/contracts";
import { snoozablePullRequests } from "@t3tools/shared/threadPullRequests";
import * as DateTime from "effect/DateTime";

import { threadPullRequestKeysEqual } from "../sourceControl/threadPullRequests.ts";

function snapshotMeetsTrigger(
  trigger: PullRequestSnoozeTrigger,
  before: ThreadPullRequestSnapshot,
  after: ThreadPullRequestSnapshot,
  watched: boolean,
): boolean {
  const reviewed =
    (after.reviewDecision === "approved" || after.reviewDecision === "changes-requested") &&
    after.reviewDecision !== before.reviewDecision;
  const checksFinished =
    before.checksState === "pending" &&
    (after.checksState === "passing" || after.checksState === "failing");
  const conflicted = after.mergeability === "conflicting" && before.mergeability !== "conflicting";
  switch (trigger) {
    case "review":
      return reviewed;
    case "checks":
      return checksFinished;
    case "conflict":
      return conflicted;
    case "update":
      // A watching agent answers its own checks; the user hears if it gets stuck.
      return reviewed || conflicted || (checksFinished && !watched);
  }
}

/**
 * Wakes a pull request snooze the way its timer would, by ending it now, when a change to the
 * thread's pull requests meets its trigger or leaves none open.
 */
export function wakePullRequestSnooze<
  Thread extends Pick<OrchestrationV2AppThread, "snoozedUntil" | "snoozeUntilPullRequest">,
>(
  before: ReadonlyArray<ThreadPullRequestLink>,
  thread: Thread,
  after: ReadonlyArray<ThreadPullRequestLink>,
  now: DateTime.Utc,
): Thread {
  const trigger = thread.snoozeUntilPullRequest;
  if (trigger == null || thread.snoozedUntil == null) return thread;
  if (DateTime.toEpochMillis(thread.snoozedUntil) <= DateTime.toEpochMillis(now)) return thread;
  const open = snoozablePullRequests(after);
  const met =
    open.length === 0 ||
    open.some((link) => {
      const previous = before.find((candidate) => threadPullRequestKeysEqual(candidate, link));
      return (
        previous?.snapshot != null &&
        link.snapshot !== null &&
        snapshotMeetsTrigger(trigger, previous.snapshot, link.snapshot, link.watch !== undefined)
      );
    });
  return met ? { ...thread, snoozedUntil: now, snoozeUntilPullRequest: null } : thread;
}

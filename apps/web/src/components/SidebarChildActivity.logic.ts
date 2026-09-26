/**
 * Sidebar rows for parents of hidden child threads (toolboxmd/t3code#31):
 * a parent reads as Working while its child threads work, exactly like a
 * native subagent fleet (`backgroundLiveness === "working"`), and surfaces a
 * child's pending approval as its own.
 */
import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { ThreadId, type EnvironmentId } from "@t3tools/contracts";
import {
  childThreadActivityByParent,
  type ChildThreadActivity,
} from "@t3tools/shared/childThreadActivity";

import { resolveWorkingStartedAt } from "./Sidebar.logic";
import { parentThreadIdOf } from "./subagentThreads";

/** Child-thread activity per scoped thread key, across environments. */
export function childThreadActivityByThreadKey(
  threads: ReadonlyArray<EnvironmentThreadShell>,
): ReadonlyMap<string, ChildThreadActivity> {
  const threadsByEnvironment = new Map<EnvironmentId, EnvironmentThreadShell[]>();
  for (const thread of threads) {
    const environmentThreads = threadsByEnvironment.get(thread.environmentId);
    if (environmentThreads) environmentThreads.push(thread);
    else threadsByEnvironment.set(thread.environmentId, [thread]);
  }
  const byKey = new Map<string, ChildThreadActivity>();
  for (const [environmentId, environmentThreads] of threadsByEnvironment) {
    for (const [threadId, activity] of childThreadActivityByParent(
      environmentThreads,
      parentThreadIdOf,
    )) {
      byKey.set(scopedThreadKey(scopeThreadRef(environmentId, ThreadId.make(threadId))), activity);
    }
  }
  return byKey;
}

/** The thread as the sidebar status resolvers should see it. */
export function withChildThreadActivity<
  T extends Pick<
    EnvironmentThreadShell,
    "hasPendingApprovals" | "hasPendingUserInput" | "backgroundLiveness"
  >,
>(thread: T, activity: ChildThreadActivity | null): T {
  if (activity === null) return thread;
  return {
    ...thread,
    hasPendingApprovals: thread.hasPendingApprovals || activity.hasPendingApprovals,
    hasPendingUserInput: thread.hasPendingUserInput || activity.hasPendingUserInput,
    backgroundLiveness: activity.workingCount > 0 ? "working" : thread.backgroundLiveness,
  };
}

/**
 * Start of the row's Working timer: the thread's own turn while it runs,
 * otherwise the earliest of its own background work and its working children.
 */
export function resolveParentWorkingStartedAt(
  thread: Pick<EnvironmentThreadShell, "latestTurn" | "session" | "backgroundLiveness">,
  activity: ChildThreadActivity | null,
): string | null {
  const own = resolveWorkingStartedAt(thread);
  const childSince = activity?.workingSince ?? null;
  const session = thread.session?.status;
  if (childSince === null || session === "running" || session === "starting") return own;
  const ownIsEarlier =
    thread.backgroundLiveness === "working" &&
    own !== null &&
    Date.parse(own) < Date.parse(childSince);
  return ownIsEarlier ? own : childSince;
}

export function childAgentsLabel(activity: ChildThreadActivity | null): string | null {
  if (activity === null || activity.workingCount === 0) return null;
  return `· ${activity.workingCount} ${activity.workingCount === 1 ? "agent" : "agents"}`;
}

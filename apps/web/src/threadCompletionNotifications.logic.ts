import { threadKey } from "@t3tools/client-runtime/state/entities";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type {
  EnvironmentId,
  OrchestrationLatestTurn,
  OrchestrationSession,
  ProjectId,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";

import { isLatestTurnSettled } from "./session-logic";

/** The thread fields a completion decision reads. */
export interface ThreadCompletionCandidate {
  readonly environmentId: EnvironmentId;
  readonly id: ThreadId;
  readonly projectId: ProjectId;
  readonly title: string;
  readonly archivedAt: string | null;
  readonly latestTurn: Pick<
    OrchestrationLatestTurn,
    "turnId" | "state" | "startedAt" | "completedAt"
  > | null;
  readonly session: Pick<OrchestrationSession, "status" | "activeTurnId"> | null;
  readonly backgroundLiveness?: "working" | "monitoring" | null | undefined;
}

export interface ThreadCompletionNotification {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly projectId: ProjectId;
  readonly turnId: TurnId;
  readonly title: string;
}

interface ObservedThread {
  readonly turnId: TurnId | null;
  readonly finished: boolean;
}

export type ObservedThreads = ReadonlyMap<string, ObservedThread>;

export const NO_OBSERVED_THREADS: ObservedThreads = new Map();

/**
 * Whether the thread's latest turn ran to completion and nothing is left
 * running behind it.
 *
 * `backgroundLiveness === "working"` keeps a thread pending: the primary agent
 * settling while delegated subagents still run is not a stopping point. Turns
 * that ended in `interrupted` or `error` carry a `completedAt` too, and neither
 * is something to announce as finished work.
 */
export function isCompletedTurn(thread: ThreadCompletionCandidate): boolean {
  if (thread.backgroundLiveness === "working") return false;
  const latestTurn = thread.latestTurn;
  if (latestTurn?.state !== "completed") return false;
  return isLatestTurnSettled(latestTurn, thread.session);
}

/**
 * Completions observed since the last call, paired with the snapshot to pass
 * back in next time.
 *
 * Announces a transition rather than a state, so it needs no clock of its own:
 * a thread is news only once this client has seen it unfinished (or on an
 * earlier turn) and then finished. A thread seen for the first time — on load,
 * on reconnect, or when an environment joins late — is recorded silently,
 * which is what keeps a page load from announcing the user's whole history.
 */
export function deriveThreadCompletionNotifications(input: {
  readonly threads: ReadonlyArray<ThreadCompletionCandidate>;
  readonly observed: ObservedThreads;
}): {
  readonly notifications: ReadonlyArray<ThreadCompletionNotification>;
  // Rebuilt from the current threads, so threads that go away drop out with it.
  readonly observed: ObservedThreads;
} {
  const observed = new Map<string, ObservedThread>();
  const notifications: ThreadCompletionNotification[] = [];

  for (const thread of input.threads) {
    if (thread.archivedAt !== null) continue;

    const key = threadKey(scopeThreadRef(thread.environmentId, thread.id));
    const turnId = thread.latestTurn?.turnId ?? null;
    const finished = isCompletedTurn(thread);
    observed.set(key, { turnId, finished });

    const previous = input.observed.get(key);
    if (previous === undefined || !finished || turnId === null) continue;
    if (previous.finished && previous.turnId === turnId) continue;

    notifications.push({
      environmentId: thread.environmentId,
      threadId: thread.id,
      projectId: thread.projectId,
      turnId,
      title: thread.title,
    });
  }

  return { notifications, observed };
}

import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { resolveFirstSeenCompletedThreads } from "./useMarkFirstSeenCompletedThreadsUnread";

const localEnvironmentId = EnvironmentId.make("environment-local");
const remoteEnvironmentId = EnvironmentId.make("environment-remote");

function thread(
  id: string,
  state: "completed" | "running" = "completed",
  environmentId = localEnvironmentId,
  turnId = `turn-${id}`,
) {
  return {
    environmentId,
    id: ThreadId.make(id),
    latestTurn: {
      turnId,
      state,
      completedAt: "2026-06-18T09:00:00.000Z",
    },
  } as const;
}

describe("resolveFirstSeenCompletedThreads", () => {
  it("seeds initial snapshot history without marking it unread", () => {
    const result = resolveFirstSeenCompletedThreads({
      threads: [thread("historical")],
      environmentSnapshotIds: [localEnvironmentId],
      previouslyObservedThreadsByEnvironment: new Map(),
    });

    expect(result.newlyUnreadThreads).toEqual([]);
    expect(result.nextObservedThreadsByEnvironment.get(localEnvironmentId)).toEqual(
      new Map([
        [
          scopedThreadKey(scopeThreadRef(localEnvironmentId, ThreadId.make("historical"))),
          { turnId: "turn-historical", state: "completed" },
        ],
      ]),
    );
  });

  it("seeds a genuinely empty snapshot before observing later completions", () => {
    const emptySnapshot = resolveFirstSeenCompletedThreads({
      threads: [],
      environmentSnapshotIds: [localEnvironmentId],
      previouslyObservedThreadsByEnvironment: new Map(),
    });
    const laterCompletion = resolveFirstSeenCompletedThreads({
      threads: [thread("completed")],
      environmentSnapshotIds: [localEnvironmentId],
      previouslyObservedThreadsByEnvironment: emptySnapshot.nextObservedThreadsByEnvironment,
    });

    expect(emptySnapshot.nextObservedThreadsByEnvironment.get(localEnvironmentId)).toEqual(
      new Map(),
    );
    expect(laterCompletion.newlyUnreadThreads).toEqual([
      {
        threadKey: scopedThreadKey(scopeThreadRef(localEnvironmentId, ThreadId.make("completed"))),
        completedAt: "2026-06-18T09:00:00.000Z",
      },
    ]);
  });

  it("marks a completed thread that first appears after bootstrap unread", () => {
    const historicalKey = scopedThreadKey(
      scopeThreadRef(localEnvironmentId, ThreadId.make("historical")),
    );
    const completedKey = scopedThreadKey(
      scopeThreadRef(localEnvironmentId, ThreadId.make("completed")),
    );
    const result = resolveFirstSeenCompletedThreads({
      threads: [thread("historical"), thread("completed")],
      environmentSnapshotIds: [localEnvironmentId],
      previouslyObservedThreadsByEnvironment: new Map([
        [
          localEnvironmentId,
          new Map([[historicalKey, { turnId: "turn-historical", state: "completed" }]]),
        ],
      ]),
    });

    expect(result.newlyUnreadThreads).toEqual([
      {
        threadKey: completedKey,
        completedAt: "2026-06-18T09:00:00.000Z",
      },
    ]);
  });

  it("does not mark a new unfinished thread or a thread outside a snapshot environment", () => {
    const result = resolveFirstSeenCompletedThreads({
      threads: [thread("running", "running"), thread("remote", "completed", remoteEnvironmentId)],
      environmentSnapshotIds: [localEnvironmentId],
      previouslyObservedThreadsByEnvironment: new Map([[localEnvironmentId, new Map()]]),
    });

    expect(result.newlyUnreadThreads).toEqual([]);
    expect(result.nextObservedThreadsByEnvironment.has(remoteEnvironmentId)).toBe(false);
  });

  it("marks a previously observed running thread unread when its turn completes", () => {
    const runningKey = scopedThreadKey(
      scopeThreadRef(localEnvironmentId, ThreadId.make("running")),
    );
    const result = resolveFirstSeenCompletedThreads({
      threads: [thread("running", "completed")],
      environmentSnapshotIds: [localEnvironmentId],
      previouslyObservedThreadsByEnvironment: new Map([
        [localEnvironmentId, new Map([[runningKey, { turnId: "turn-running", state: "running" }]])],
      ]),
    });

    expect(result.newlyUnreadThreads).toEqual([
      {
        threadKey: runningKey,
        completedAt: "2026-06-18T09:00:00.000Z",
      },
    ]);
  });

  it("marks a later completed turn unread even when the prior turn was completed", () => {
    const threadKey = scopedThreadKey(scopeThreadRef(localEnvironmentId, ThreadId.make("reused")));
    const result = resolveFirstSeenCompletedThreads({
      threads: [thread("reused", "completed", localEnvironmentId, "turn-new")],
      environmentSnapshotIds: [localEnvironmentId],
      previouslyObservedThreadsByEnvironment: new Map([
        [
          localEnvironmentId,
          new Map([[threadKey, { turnId: "turn-previous", state: "completed" }]]),
        ],
      ]),
    });

    expect(result.newlyUnreadThreads).toHaveLength(1);
  });

  it("retains observations while a thread is archived and does not flag it on re-entry", () => {
    const threadKey = scopedThreadKey(
      scopeThreadRef(localEnvironmentId, ThreadId.make("archived")),
    );
    const previous = new Map([
      [localEnvironmentId, new Map([[threadKey, { turnId: "turn-archived", state: "completed" }]])],
    ]);
    const whileArchived = resolveFirstSeenCompletedThreads({
      threads: [],
      environmentSnapshotIds: [localEnvironmentId],
      previouslyObservedThreadsByEnvironment: previous,
    });
    const afterUnarchive = resolveFirstSeenCompletedThreads({
      threads: [thread("archived")],
      environmentSnapshotIds: [localEnvironmentId],
      previouslyObservedThreadsByEnvironment: whileArchived.nextObservedThreadsByEnvironment,
    });

    expect(
      whileArchived.nextObservedThreadsByEnvironment.get(localEnvironmentId)?.has(threadKey),
    ).toBe(true);
    expect(afterUnarchive.newlyUnreadThreads).toEqual([]);
  });

  it("does not mark the currently active thread unread", () => {
    const activeKey = scopedThreadKey(scopeThreadRef(localEnvironmentId, ThreadId.make("active")));
    const result = resolveFirstSeenCompletedThreads({
      threads: [thread("active")],
      environmentSnapshotIds: [localEnvironmentId],
      previouslyObservedThreadsByEnvironment: new Map([[localEnvironmentId, new Map()]]),
      activeThreadKey: activeKey,
    });

    expect(result.newlyUnreadThreads).toEqual([]);
  });
});

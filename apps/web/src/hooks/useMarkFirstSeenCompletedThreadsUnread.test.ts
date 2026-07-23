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
) {
  return {
    environmentId,
    id: ThreadId.make(id),
    latestTurn: {
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
      previouslySeenThreadKeysByEnvironment: new Map(),
    });

    expect(result.newlyUnreadThreads).toEqual([]);
    expect(result.nextSeenThreadKeysByEnvironment.get(localEnvironmentId)).toEqual(
      new Set([scopedThreadKey(scopeThreadRef(localEnvironmentId, ThreadId.make("historical")))]),
    );
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
      previouslySeenThreadKeysByEnvironment: new Map([
        [localEnvironmentId, new Set([historicalKey])],
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
      previouslySeenThreadKeysByEnvironment: new Map([[localEnvironmentId, new Set()]]),
    });

    expect(result.newlyUnreadThreads).toEqual([]);
    expect(result.nextSeenThreadKeysByEnvironment.has(remoteEnvironmentId)).toBe(false);
  });
});

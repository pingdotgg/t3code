import { EnvironmentId, ProjectId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/unstable/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";

import { DEFAULT_INTERACTION_MODE, DEFAULT_RUNTIME_MODE, type Thread } from "./types";
import {
  formatWorktreePathForDisplay,
  getOrphanedWorktreePathForThread,
  scheduleThreadDeletionCleanup,
} from "./worktreeCleanup";

const localEnvironmentId = EnvironmentId.make("environment-local");

function makeThread(overrides: Partial<Thread> = {}): Thread {
  return {
    id: ThreadId.make("thread-1"),
    environmentId: localEnvironmentId,
    projectId: ProjectId.make("project-1"),
    title: "Thread",
    modelSelection: {
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-5.3-codex",
    },
    runtimeMode: DEFAULT_RUNTIME_MODE,
    interactionMode: DEFAULT_INTERACTION_MODE,
    session: null,
    messages: [],
    checkpoints: [],
    activities: [],
    proposedPlans: [],
    createdAt: "2026-02-13T00:00:00.000Z",
    updatedAt: "2026-02-13T00:00:00.000Z",
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    deletedAt: null,
    latestTurn: null,
    branch: null,
    worktreePath: null,
    ...overrides,
  };
}

describe("getOrphanedWorktreePathForThread", () => {
  it("returns null when the target thread does not exist", () => {
    const result = getOrphanedWorktreePathForThread([], ThreadId.make("missing-thread"));
    expect(result).toBeNull();
  });

  it("returns null when the target thread has no worktree", () => {
    const threads = [makeThread()];
    const result = getOrphanedWorktreePathForThread(threads, ThreadId.make("thread-1"));
    expect(result).toBeNull();
  });

  it("returns the path when no other thread links to that worktree", () => {
    const threads = [makeThread({ worktreePath: "/tmp/repo/worktrees/feature-a" })];
    const result = getOrphanedWorktreePathForThread(threads, ThreadId.make("thread-1"));
    expect(result).toBe("/tmp/repo/worktrees/feature-a");
  });

  it("returns null when another thread links to the same worktree", () => {
    const threads = [
      makeThread({
        id: ThreadId.make("thread-1"),
        worktreePath: "/tmp/repo/worktrees/feature-a",
      }),
      makeThread({
        id: ThreadId.make("thread-2"),
        worktreePath: "/tmp/repo/worktrees/feature-a",
      }),
    ];
    const result = getOrphanedWorktreePathForThread(threads, ThreadId.make("thread-1"));
    expect(result).toBeNull();
  });

  it("ignores threads linked to different worktrees", () => {
    const threads = [
      makeThread({
        id: ThreadId.make("thread-1"),
        worktreePath: "/tmp/repo/worktrees/feature-a",
      }),
      makeThread({
        id: ThreadId.make("thread-2"),
        worktreePath: "/tmp/repo/worktrees/feature-b",
      }),
    ];
    const result = getOrphanedWorktreePathForThread(threads, ThreadId.make("thread-1"));
    expect(result).toBe("/tmp/repo/worktrees/feature-a");
  });
});

describe("formatWorktreePathForDisplay", () => {
  it("shows only the last path segment for unix-like paths", () => {
    const result = formatWorktreePathForDisplay(
      "/Users/julius/.t3/worktrees/t3code-mvp/t3code-4e609bb8",
    );
    expect(result).toBe("t3code-4e609bb8");
  });

  it("normalizes windows separators before selecting the final segment", () => {
    const result = formatWorktreePathForDisplay(
      "C:\\Users\\julius\\.t3\\worktrees\\t3code-mvp\\t3code-4e609bb8",
    );
    expect(result).toBe("t3code-4e609bb8");
  });

  it("uses the final segment even when outside ~/.t3/worktrees", () => {
    const result = formatWorktreePathForDisplay("/tmp/custom-worktrees/my-worktree");
    expect(result).toBe("my-worktree");
  });

  it("ignores trailing slashes", () => {
    const result = formatWorktreePathForDisplay("/tmp/custom-worktrees/my-worktree/");
    expect(result).toBe("my-worktree");
  });
});

describe("scheduleThreadDeletionCleanup", () => {
  it("starts multiple cleanups without waiting for earlier cleanup", () => {
    const stopSession = vi.fn(
      () => new Promise<ReturnType<typeof AsyncResult.success<void>>>(() => undefined),
    );
    const removeWorktree = vi.fn(
      () => new Promise<ReturnType<typeof AsyncResult.success<void>>>(() => undefined),
    );
    const onFailure = vi.fn();

    scheduleThreadDeletionCleanup({
      stopSession,
      closeTerminals: async () => AsyncResult.success(undefined),
      worktree: {
        environmentId: localEnvironmentId,
        cwd: "/tmp/repo",
        path: "/tmp/repo/worktrees/feature-a",
        remove: removeWorktree,
        onFailure,
      },
    });
    scheduleThreadDeletionCleanup({
      stopSession,
      closeTerminals: async () => AsyncResult.success(undefined),
      worktree: {
        environmentId: localEnvironmentId,
        cwd: "/tmp/repo",
        path: "/tmp/repo/worktrees/feature-b",
        remove: removeWorktree,
        onFailure,
      },
    });

    expect(stopSession).toHaveBeenCalledTimes(2);
    expect(removeWorktree).not.toHaveBeenCalled();
    expect(onFailure).not.toHaveBeenCalled();
  });

  it("waits for runtime cleanup before removing the worktree", async () => {
    const calls: Array<string> = [];
    const onFailure = vi.fn();

    scheduleThreadDeletionCleanup({
      stopSession: async () => {
        calls.push("stop-session");
      },
      closeTerminals: async () => {
        calls.push("close-terminals");
      },
      worktree: {
        environmentId: localEnvironmentId,
        cwd: "/tmp/repo",
        path: "/tmp/repo/worktrees/feature-a",
        remove: async (input) => {
          calls.push("remove-worktree");
          expect(input).toEqual({
            environmentId: localEnvironmentId,
            input: {
              cwd: "/tmp/repo",
              path: "/tmp/repo/worktrees/feature-a",
              force: true,
            },
          });
          return AsyncResult.success(undefined);
        },
        onFailure,
      },
    });

    await vi.waitFor(() => {
      expect(calls).toEqual(["stop-session", "close-terminals", "remove-worktree"]);
    });
    expect(onFailure).not.toHaveBeenCalled();
  });

  it("reports a background removal failure", async () => {
    const failure = AsyncResult.failure<void, Error>(Cause.fail(new Error("remove failed")));
    const onFailure = vi.fn();

    scheduleThreadDeletionCleanup({
      stopSession: null,
      closeTerminals: async () => AsyncResult.success(undefined),
      worktree: {
        environmentId: localEnvironmentId,
        cwd: "/tmp/repo",
        path: "/tmp/repo/worktrees/feature-a",
        remove: async () => failure,
        onFailure,
      },
    });

    await vi.waitFor(() => expect(onFailure).toHaveBeenCalledOnce());
    expect(onFailure).toHaveBeenCalledWith(failure);
  });

  it("does not report an interruption as a worktree removal failure", async () => {
    const interrupted = AsyncResult.failure<void, never>(Cause.interrupt(1));
    const onFailure = vi.fn();

    scheduleThreadDeletionCleanup({
      stopSession: null,
      closeTerminals: async () => AsyncResult.success(undefined),
      worktree: {
        environmentId: localEnvironmentId,
        cwd: "/tmp/repo",
        path: "/tmp/repo/worktrees/feature-a",
        remove: async () => interrupted,
        onFailure,
      },
    });

    await Promise.resolve();
    await Promise.resolve();
    expect(onFailure).not.toHaveBeenCalled();
  });
});

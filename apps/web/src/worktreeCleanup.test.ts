import { EnvironmentId, ProjectId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { DEFAULT_INTERACTION_MODE, DEFAULT_RUNTIME_MODE, type Thread } from "./types";
import {
  formatWorktreePathForDisplay,
  getOrphanedWorktreePathForThread,
  getOrphanedWorktreePathsForThreads,
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

describe("getOrphanedWorktreePathsForThreads", () => {
  it("returns nothing when no thread in the batch has a worktree", () => {
    const threads = [
      makeThread({ id: ThreadId.make("thread-1"), worktreePath: null }),
      makeThread({ id: ThreadId.make("thread-2"), worktreePath: null }),
    ];
    const result = getOrphanedWorktreePathsForThreads(
      threads,
      new Set([ThreadId.make("thread-1"), ThreadId.make("thread-2")]),
    );
    expect(result).toEqual([]);
  });

  it("collects one path per deleted thread that owns its worktree alone", () => {
    const threads = [
      makeThread({ id: ThreadId.make("thread-1"), worktreePath: "/tmp/repo/worktrees/a" }),
      makeThread({ id: ThreadId.make("thread-2"), worktreePath: "/tmp/repo/worktrees/b" }),
      makeThread({ id: ThreadId.make("thread-3"), worktreePath: "/tmp/repo/worktrees/c" }),
    ];
    const result = getOrphanedWorktreePathsForThreads(
      threads,
      new Set([ThreadId.make("thread-1"), ThreadId.make("thread-2")]),
    );
    expect(result).toEqual(["/tmp/repo/worktrees/a", "/tmp/repo/worktrees/b"]);
  });

  it("skips a worktree a surviving thread still points at", () => {
    const threads = [
      makeThread({ id: ThreadId.make("thread-1"), worktreePath: "/tmp/repo/worktrees/shared" }),
      makeThread({ id: ThreadId.make("thread-2"), worktreePath: "/tmp/repo/worktrees/shared" }),
    ];
    const result = getOrphanedWorktreePathsForThreads(
      threads,
      new Set([ThreadId.make("thread-1")]),
    );
    expect(result).toEqual([]);
  });

  it("counts a shared worktree once when the whole batch releases it", () => {
    const threads = [
      makeThread({ id: ThreadId.make("thread-1"), worktreePath: "/tmp/repo/worktrees/shared" }),
      makeThread({ id: ThreadId.make("thread-2"), worktreePath: "/tmp/repo/worktrees/shared" }),
    ];
    const result = getOrphanedWorktreePathsForThreads(
      threads,
      new Set([ThreadId.make("thread-1"), ThreadId.make("thread-2")]),
    );
    expect(result).toEqual(["/tmp/repo/worktrees/shared"]);
  });

  it("ignores blank worktree paths", () => {
    const threads = [
      makeThread({ id: ThreadId.make("thread-1"), worktreePath: "   " }),
      makeThread({ id: ThreadId.make("thread-2"), worktreePath: "/tmp/repo/worktrees/a" }),
    ];
    const result = getOrphanedWorktreePathsForThreads(
      threads,
      new Set([ThreadId.make("thread-1"), ThreadId.make("thread-2")]),
    );
    expect(result).toEqual(["/tmp/repo/worktrees/a"]);
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

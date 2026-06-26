import { EnvironmentId, ProjectId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { DEFAULT_INTERACTION_MODE, DEFAULT_RUNTIME_MODE, type Thread } from "./types";
import {
  formatWorktreePathForDisplay,
  getOrphanedWorktreePathForThread,
  getOrphanedWorktreesForThread,
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
    worktrees: [],
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

describe("getOrphanedWorktreesForThread", () => {
  it("returns every per-root worktree for an isolated multi-repo run", () => {
    const threads = [
      makeThread({
        id: ThreadId.make("thread-1"),
        worktreePath: "/tmp/wt/backend",
        worktrees: [
          { repoRoot: "/src/backend", worktreePath: "/tmp/wt/backend" },
          { repoRoot: "/src/frontend", worktreePath: "/tmp/wt/frontend" },
        ],
      }),
    ];
    const result = getOrphanedWorktreesForThread(threads, ThreadId.make("thread-1"));
    expect(result).toEqual([
      { repoRoot: "/src/backend", worktreePath: "/tmp/wt/backend" },
      { repoRoot: "/src/frontend", worktreePath: "/tmp/wt/frontend" },
    ]);
  });

  it("excludes per-root worktrees shared by another surviving thread", () => {
    const threads = [
      makeThread({
        id: ThreadId.make("thread-1"),
        worktrees: [
          { repoRoot: "/src/backend", worktreePath: "/tmp/wt/backend" },
          { repoRoot: "/src/frontend", worktreePath: "/tmp/wt/frontend" },
        ],
      }),
      makeThread({
        id: ThreadId.make("thread-2"),
        worktrees: [{ repoRoot: "/src/frontend", worktreePath: "/tmp/wt/frontend" }],
      }),
    ];
    const result = getOrphanedWorktreesForThread(threads, ThreadId.make("thread-1"));
    expect(result).toEqual([{ repoRoot: "/src/backend", worktreePath: "/tmp/wt/backend" }]);
  });

  it("falls back to the legacy single worktree path with a null repoRoot", () => {
    const threads = [makeThread({ worktreePath: "/tmp/wt/legacy" })];
    const result = getOrphanedWorktreesForThread(threads, ThreadId.make("thread-1"));
    expect(result).toEqual([{ repoRoot: null, worktreePath: "/tmp/wt/legacy" }]);
  });

  it("returns an empty list when the thread owns no worktrees", () => {
    expect(getOrphanedWorktreesForThread([makeThread()], ThreadId.make("thread-1"))).toEqual([]);
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

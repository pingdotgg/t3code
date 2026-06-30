import { EnvironmentId, ProjectId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { DEFAULT_INTERACTION_MODE, DEFAULT_RUNTIME_MODE, type Thread } from "./types";
import { formatWorktreePathForDisplay, getOrphanedWorktreePathForThread } from "./worktreeCleanup";
import type { VcsManagedWorktree } from "@t3tools/contracts";
import {
  classifyManagedWorktrees,
  selectWorktreesForScope,
  type WorktreeThreadRef,
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

function wt(path: string, isDirty = false): VcsManagedWorktree {
  return { path, refName: path.split("/").pop() ?? path, isDirty };
}

describe("classifyManagedWorktrees", () => {
  it("marks worktrees with a live thread as active", () => {
    const refs: WorktreeThreadRef[] = [{ worktreePath: "/wt/a", isArchived: false }];
    const [classified] = classifyManagedWorktrees([wt("/wt/a")], refs);
    expect(classified?.classification).toBe("active");
  });

  it("marks worktrees referenced only by archived threads as archived-only", () => {
    const refs: WorktreeThreadRef[] = [{ worktreePath: "/wt/a", isArchived: true }];
    const [classified] = classifyManagedWorktrees([wt("/wt/a")], refs);
    expect(classified?.classification).toBe("archived-only");
  });

  it("marks worktrees with no thread as orphaned", () => {
    const [classified] = classifyManagedWorktrees([wt("/wt/a")], []);
    expect(classified?.classification).toBe("orphaned");
  });

  it("matches a live thread despite trailing-slash and separator differences", () => {
    const refs: WorktreeThreadRef[] = [{ worktreePath: "C:\\repo\\worktrees\\a\\", isArchived: false }];
    const [classified] = classifyManagedWorktrees([wt("C:/repo/worktrees/a")], refs);
    expect(classified?.classification).toBe("active");
  });
});

describe("selectWorktreesForScope", () => {
  const classified = classifyManagedWorktrees(
    [wt("/wt/orphan"), wt("/wt/arch"), wt("/wt/active")],
    [
      { worktreePath: "/wt/arch", isArchived: true },
      { worktreePath: "/wt/active", isArchived: false },
    ],
  );

  it("orphaned scope selects only orphaned worktrees", () => {
    const selected = selectWorktreesForScope(classified, "orphaned");
    expect(selected.map((c) => c.worktree.path)).toEqual(["/wt/orphan"]);
  });

  it("orphaned-archived scope adds archived-only worktrees", () => {
    const selected = selectWorktreesForScope(classified, "orphaned-archived");
    expect(selected.map((c) => c.worktree.path).sort()).toEqual(["/wt/arch", "/wt/orphan"]);
  });

  it("never selects active worktrees", () => {
    const selected = selectWorktreesForScope(classified, "orphaned-archived");
    expect(selected.some((c) => c.worktree.path === "/wt/active")).toBe(false);
  });
});

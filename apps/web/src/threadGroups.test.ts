import { ProjectId, ThreadId, type GitStatusResult } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import {
  MAIN_THREAD_GROUP_ID,
  buildThreadGroupId,
  orderProjectThreadGroups,
  resolveProjectThreadGroupPrById,
  reorderProjectThreadGroupOrder,
} from "./threadGroups";
import { DEFAULT_INTERACTION_MODE, DEFAULT_RUNTIME_MODE, type Project, type Thread } from "./types";

function makeProject(overrides: Partial<Project> = {}): Project {
  return {
    id: ProjectId.makeUnsafe("project-1"),
    name: "Project",
    cwd: "/tmp/project",
    model: "gpt-5-codex",
    expanded: true,
    scripts: [],
    threadGroupOrder: [],
    sortOrder: 0,
    ...overrides,
  };
}

function makeThread(overrides: Partial<Thread> = {}): Thread {
  return {
    id: ThreadId.makeUnsafe("thread-1"),
    codexThreadId: null,
    projectId: ProjectId.makeUnsafe("project-1"),
    title: "Thread",
    model: "gpt-5-codex",
    runtimeMode: DEFAULT_RUNTIME_MODE,
    interactionMode: DEFAULT_INTERACTION_MODE,
    session: null,
    messages: [],
    turnDiffSummaries: [],
    activities: [],
    proposedPlans: [],
    error: null,
    createdAt: "2026-03-01T00:00:00.000Z",
    latestTurn: null,
    branch: null,
    worktreePath: null,
    ...overrides,
  };
}

function makeGitStatus(overrides: Partial<GitStatusResult> = {}): GitStatusResult {
  return {
    branch: "feature/a",
    hasWorkingTreeChanges: false,
    workingTree: {
      files: [],
      insertions: 0,
      deletions: 0,
    },
    hasUpstream: true,
    aheadCount: 0,
    behindCount: 0,
    pr: null,
    ...overrides,
  };
}

describe("threadGroups", () => {
  it("uses worktree identity before branch identity", () => {
    expect(
      buildThreadGroupId({
        branch: "feature/a",
        worktreePath: "/tmp/project/.t3/worktrees/feature-a",
      }),
    ).toBe("worktree:/tmp/project/.t3/worktrees/feature-a");
    expect(buildThreadGroupId({ branch: "feature/a", worktreePath: null })).toBe("branch:feature/a");
    expect(buildThreadGroupId({ branch: null, worktreePath: null })).toBe(MAIN_THREAD_GROUP_ID);
  });

  it("labels worktree groups from the path when branch metadata is missing", () => {
    const project = makeProject();
    const [mainGroup, worktreeGroup] = orderProjectThreadGroups({
      project,
      threads: [
        makeThread({
          id: ThreadId.makeUnsafe("thread-main"),
        }),
        makeThread({
          id: ThreadId.makeUnsafe("thread-worktree"),
          branch: null,
          worktreePath: "/tmp/project/.t3/worktrees/feature-draft-only",
        }),
      ],
    });

    expect(mainGroup?.label).toBe("Main");
    expect(worktreeGroup?.label).toBe("feature-draft-only");
  });

  it("normalizes branch and worktree metadata stored on ordered groups", () => {
    const groups = orderProjectThreadGroups({
      project: makeProject(),
      threads: [
        makeThread({
          id: ThreadId.makeUnsafe("thread-worktree-spaced"),
          branch: " feature/a ",
          worktreePath: " /tmp/project/.t3/worktrees/feature-a ",
        }),
      ],
    });

    expect(groups[1]).toMatchObject({
      id: "worktree:/tmp/project/.t3/worktrees/feature-a",
      branch: "feature/a",
      worktreePath: "/tmp/project/.t3/worktrees/feature-a",
      label: "feature/a",
    });

    const prByGroupId = resolveProjectThreadGroupPrById({
      groups,
      projectCwd: "/tmp/project",
      statusByCwd: new Map<string, GitStatusResult>([
        [
          "/tmp/project/.t3/worktrees/feature-a",
          makeGitStatus({
            branch: "feature/a",
            pr: {
              number: 12,
              title: "Feature A",
              url: "https://example.com/pr/12",
              baseBranch: "main",
              headBranch: "feature/a",
              state: "open",
            },
          }),
        ],
      ]),
    });

    expect(prByGroupId.get("worktree:/tmp/project/.t3/worktrees/feature-a")?.number).toBe(12);
  });

  it("refreshes group metadata when a newer thread in the same normalized group arrives", () => {
    const groups = orderProjectThreadGroups({
      project: makeProject(),
      threads: [
        makeThread({
          id: ThreadId.makeUnsafe("thread-worktree-older"),
          branch: null,
          worktreePath: "/tmp/project/.t3/worktrees/feature-a",
          createdAt: "2026-03-01T00:00:00.000Z",
        }),
        makeThread({
          id: ThreadId.makeUnsafe("thread-worktree-newer"),
          branch: "feature/a",
          worktreePath: " /tmp/project/.t3/worktrees/feature-a ",
          createdAt: "2026-03-05T00:00:00.000Z",
        }),
      ],
    });

    expect(groups[1]).toMatchObject({
      id: "worktree:/tmp/project/.t3/worktrees/feature-a",
      branch: "feature/a",
      worktreePath: "/tmp/project/.t3/worktrees/feature-a",
      label: "feature/a",
      latestActivityAt: "2026-03-05T00:00:00.000Z",
    });
  });

  it("pins Main first, inserts new groups next, then keeps shared project order", () => {
    const project = makeProject({
      threadGroupOrder: ["worktree:/tmp/project/.t3/worktrees/feature-a", "branch:release/1.0"],
    });
    const groups = orderProjectThreadGroups({
      project,
      threads: [
        makeThread({
          id: ThreadId.makeUnsafe("thread-main"),
          createdAt: "2026-03-01T00:00:00.000Z",
        }),
        makeThread({
          id: ThreadId.makeUnsafe("thread-feature-b"),
          branch: "feature/b",
          worktreePath: "/tmp/project/.t3/worktrees/feature-b",
          createdAt: "2026-03-05T00:00:00.000Z",
        }),
        makeThread({
          id: ThreadId.makeUnsafe("thread-feature-a"),
          branch: "feature/a",
          worktreePath: "/tmp/project/.t3/worktrees/feature-a",
          createdAt: "2026-03-04T00:00:00.000Z",
        }),
        makeThread({
          id: ThreadId.makeUnsafe("thread-release"),
          branch: "release/1.0",
          worktreePath: null,
          createdAt: "2026-03-03T00:00:00.000Z",
        }),
      ],
    });

    expect(groups.map((group) => group.id)).toEqual([
      MAIN_THREAD_GROUP_ID,
      "worktree:/tmp/project/.t3/worktrees/feature-b",
      "worktree:/tmp/project/.t3/worktrees/feature-a",
      "branch:release/1.0",
    ]);
  });

  it("reorders non-main groups without losing unknown entries", () => {
    expect(
      reorderProjectThreadGroupOrder({
        currentOrder: ["worktree:/tmp/project/.t3/worktrees/feature-a", "branch:release/1.0"],
        movedGroupId: "branch:release/1.0",
        beforeGroupId: "worktree:/tmp/project/.t3/worktrees/feature-a",
      }),
    ).toEqual(["branch:release/1.0", "worktree:/tmp/project/.t3/worktrees/feature-a"]);
  });

  it("ignores Main and duplicate ids from shared project order", () => {
    const project = makeProject({
      threadGroupOrder: [
        MAIN_THREAD_GROUP_ID,
        "branch:release/1.0",
        "branch:release/1.0",
        "worktree:/tmp/project/.t3/worktrees/feature-a",
      ],
    });
    const groups = orderProjectThreadGroups({
      project,
      threads: [
        makeThread({
          id: ThreadId.makeUnsafe("thread-main"),
          createdAt: "2026-03-01T00:00:00.000Z",
        }),
        makeThread({
          id: ThreadId.makeUnsafe("thread-release"),
          branch: "release/1.0",
          worktreePath: null,
          createdAt: "2026-03-03T00:00:00.000Z",
        }),
        makeThread({
          id: ThreadId.makeUnsafe("thread-feature-a"),
          branch: "feature/a",
          worktreePath: "/tmp/project/.t3/worktrees/feature-a",
          createdAt: "2026-03-04T00:00:00.000Z",
        }),
      ],
    });

    expect(groups.map((group) => group.id)).toEqual([
      MAIN_THREAD_GROUP_ID,
      "branch:release/1.0",
      "worktree:/tmp/project/.t3/worktrees/feature-a",
    ]);
  });

  it("keeps reordered shared group order non-main and unique", () => {
    expect(
      reorderProjectThreadGroupOrder({
        currentOrder: [
          MAIN_THREAD_GROUP_ID,
          "branch:release/1.0",
          "branch:release/1.0",
        ],
        movedGroupId: "worktree:/tmp/project/.t3/worktrees/feature-a",
        beforeGroupId: MAIN_THREAD_GROUP_ID,
      }),
    ).toEqual([
      "worktree:/tmp/project/.t3/worktrees/feature-a",
      "branch:release/1.0",
    ]);
  });

  it("treats dropping a group onto itself as a no-op", () => {
    expect(
      reorderProjectThreadGroupOrder({
        currentOrder: [
          "worktree:/tmp/project/.t3/worktrees/feature-a",
          "branch:release/1.0",
          "worktree:/tmp/project/.t3/worktrees/feature-b",
        ],
        movedGroupId: "branch:release/1.0",
        beforeGroupId: "branch:release/1.0",
      }),
    ).toEqual([
      "worktree:/tmp/project/.t3/worktrees/feature-a",
      "branch:release/1.0",
      "worktree:/tmp/project/.t3/worktrees/feature-b",
    ]);
  });

  it("includes draft-only groups in ordering", () => {
    const project = makeProject({
      threadGroupOrder: [],
    });
    const groups = orderProjectThreadGroups({
      project,
      threads: [
        {
          branch: "feature/draft-only",
          worktreePath: "/tmp/project/.t3/worktrees/feature-draft-only",
          createdAt: "2026-03-06T00:00:00.000Z",
        },
      ],
    });

    expect(groups.map((group) => group.id)).toEqual([
      MAIN_THREAD_GROUP_ID,
      "worktree:/tmp/project/.t3/worktrees/feature-draft-only",
    ]);
  });

  it("resolves PR state for worktree and branch groups but never Main", () => {
    const groups = orderProjectThreadGroups({
      project: makeProject(),
      threads: [
        makeThread({
          id: ThreadId.makeUnsafe("thread-main"),
        }),
        makeThread({
          id: ThreadId.makeUnsafe("thread-branch"),
          branch: "feature/a",
          worktreePath: null,
        }),
        makeThread({
          id: ThreadId.makeUnsafe("thread-worktree"),
          branch: "feature/b",
          worktreePath: "/tmp/project/.t3/worktrees/feature-b",
        }),
      ],
    });

    const prByGroupId = resolveProjectThreadGroupPrById({
      groups,
      projectCwd: "/tmp/project",
      statusByCwd: new Map<string, GitStatusResult>([
        [
          "/tmp/project",
          makeGitStatus({
            branch: "feature/a",
            pr: {
              number: 12,
              title: "Feature A",
              url: "https://example.com/pr/12",
              baseBranch: "main",
              headBranch: "feature/a",
              state: "open",
            },
          }),
        ],
        [
          "/tmp/project/.t3/worktrees/feature-b",
          makeGitStatus({
            branch: "feature/b",
            pr: {
              number: 34,
              title: "Feature B",
              url: "https://example.com/pr/34",
              baseBranch: "main",
              headBranch: "feature/b",
              state: "merged",
            },
          }),
        ],
      ]),
    });

    expect(prByGroupId.get(MAIN_THREAD_GROUP_ID)).toBeNull();
    expect(prByGroupId.get("branch:feature/a")?.number).toBe(12);
    expect(prByGroupId.get("worktree:/tmp/project/.t3/worktrees/feature-b")?.number).toBe(34);
  });

  it("omits group PR state when the git status branch does not match the group branch", () => {
    const groups = orderProjectThreadGroups({
      project: makeProject(),
      threads: [
        makeThread({
          id: ThreadId.makeUnsafe("thread-worktree"),
          branch: "feature/b",
          worktreePath: "/tmp/project/.t3/worktrees/feature-b",
        }),
      ],
    });

    const prByGroupId = resolveProjectThreadGroupPrById({
      groups,
      projectCwd: "/tmp/project",
      statusByCwd: new Map<string, GitStatusResult>([
        [
          "/tmp/project/.t3/worktrees/feature-b",
          makeGitStatus({
            branch: "feature/c",
            pr: {
              number: 99,
              title: "Wrong Branch",
              url: "https://example.com/pr/99",
              baseBranch: "main",
              headBranch: "feature/c",
              state: "closed",
            },
          }),
        ],
      ]),
    });

    expect(prByGroupId.get("worktree:/tmp/project/.t3/worktrees/feature-b")).toBeNull();
  });
});

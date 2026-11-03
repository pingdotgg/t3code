import type { ThreadCheckpointSummary } from "@t3tools/client-runtime/state/thread-checkpoints";
import { CheckpointRef, CheckpointScopeId, RunId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { buildReviewSectionItems, resolveReviewSelectedSectionId } from "./reviewModel";
import {
  checkpointsForReviewRepository,
  moveReviewSectionId,
  resolveReviewRepository,
  reviewRepositoriesFromWorkspace,
  reviewRepositorySectionPrefix,
  turnDiffForReviewRepository,
  withOutsideReviewRepository,
} from "./reviewRepositories";

// A task folder thread: each repo's cwd is its worktree, its tracked path stays the checkout.
const [home, infra, infraPipe] = reviewRepositoriesFromWorkspace([
  {
    name: "app",
    cwd: "/tasks/fix/app",
    originalPath: "/code/app",
    relativePath: "",
    kind: "home",
    missing: false,
  },
  {
    name: "infra",
    cwd: "/tasks/fix/infra",
    originalPath: "/code/infra",
    relativePath: "../infra",
    kind: "repository",
    missing: false,
  },
  {
    // Holds the delimiter right after another repo's cwd.
    name: "infra|b",
    cwd: "/tasks/fix/infra|b",
    originalPath: "/code/infra|b",
    relativePath: "../infra|b",
    kind: "repository",
    missing: false,
  },
]);

const file = (path: string) => ({ path, kind: "modified", additions: 1, deletions: 0 });

function summary(turn: number, input: Partial<ThreadCheckpointSummary> = {}) {
  return {
    runId: RunId.make(`run-${turn}`),
    checkpointTurnCount: turn,
    checkpointRef: CheckpointRef.make(`ref-${turn}`),
    status: "ready",
    files: [],
    repositories: [],
    outsideEdits: [],
    assistantMessageId: null,
    completedAt: "2026-10-27T00:00:00.000Z",
    ...input,
  } satisfies ThreadCheckpointSummary;
}

function infraCheckpoint(
  status: ThreadCheckpointSummary["status"],
  files: ReadonlyArray<ReturnType<typeof file>>,
) {
  return {
    scopeId: CheckpointScopeId.make("scope:infra"),
    name: "infra",
    repositoryPath: "/code/infra",
    cwd: "/tasks/fix/infra",
    status,
    files,
  };
}

describe("review repositories", () => {
  it("keeps home section ids and scopes other repos by cwd", () => {
    const repositories = [home!, infra!, infraPipe!];
    const infraTurn = `${reviewRepositorySectionPrefix(infra!)}turn:2`;
    const pipeTurn = `${reviewRepositorySectionPrefix(infraPipe!)}turn:2`;

    expect(reviewRepositorySectionPrefix(home!)).toBe("");
    expect(infraTurn).toBe("repo:/tasks/fix/infra|turn:2");
    expect(resolveReviewRepository(repositories, "turn:2")).toBe(home);
    expect(resolveReviewRepository(repositories, null)).toBe(home);
    expect(resolveReviewRepository(repositories, infraTurn)).toBe(infra);
    expect(resolveReviewRepository(repositories, pipeTurn)).toBe(infraPipe);
    // A plain-folder home lists no home repo, so unscoped ids fall back to the first repo.
    expect(resolveReviewRepository([infra!, infraPipe!], "turn:2")).toBe(infra);
    expect(resolveReviewRepository([], "turn:2")).toBeNull();

    expect(moveReviewSectionId(infraTurn, infra!, home!)).toBe("turn:2");
    expect(moveReviewSectionId("git:working-tree", home!, infra!)).toBe(
      "repo:/tasks/fix/infra|git:working-tree",
    );
  });

  it("builds one repo's turn and git sections from its own checkpoints", () => {
    const summaries = [
      summary(1, { files: [file("README.md")] }),
      summary(2, {
        status: "missing",
        repositories: [infraCheckpoint("ready", [file("main.tf"), file("vars.tf")])],
      }),
      summary(3, { repositories: [infraCheckpoint("error", [])] }),
    ];

    const infraCheckpoints = checkpointsForReviewRepository(summaries, infra!);
    expect(infraCheckpoints.map((entry) => [entry.checkpointTurnCount, entry.status])).toEqual([
      [2, "ready"],
      [3, "error"],
    ]);
    expect(checkpointsForReviewRepository(summaries, home!)).toBe(summaries);

    const sections = buildReviewSectionItems({
      checkpoints: infraCheckpoints,
      gitSections: [],
      turnDiffById: {},
      loadingGitSections: true,
      idPrefix: reviewRepositorySectionPrefix(infra!),
      titleSuffix: " · infra",
    });
    expect(sections.map((section) => [section.id, section.title, section.subtitle])).toEqual([
      ["repo:/tasks/fix/infra|turn:2", "Turn 2 · infra", "2 files changed"],
      ["repo:/tasks/fix/infra|git:branch-range", "Changes · infra", null],
    ]);
    // A section the repo lacks falls back to that repo's Changes, never to home's.
    expect(resolveReviewSelectedSectionId(sections, "repo:/tasks/fix/infra|turn:9")).toBe(
      "repo:/tasks/fix/infra|git:branch-range",
    );
  });

  it("reads each repo's patch from a turn diff", () => {
    const turnDiff = {
      diff: "home patch",
      repositories: [
        { name: "infra", repositoryPath: "/code/infra", relativePath: "../infra", diff: "infra" },
      ],
    };
    expect(turnDiffForReviewRepository(turnDiff, home!)).toBe("home patch");
    expect(turnDiffForReviewRepository(turnDiff, infra!)).toBe("infra");
    expect(turnDiffForReviewRepository(turnDiff, infraPipe!)).toBe("");
    expect(turnDiffForReviewRepository({ diff: "home patch" }, null)).toBe("home patch");
    expect(turnDiffForReviewRepository(undefined, infra!)).toBeUndefined();
  });

  it("reviews an edited checkout outside the thread without the thread's history", () => {
    // The agent edited the real infra checkout instead of the task folder's worktree.
    const repositories = withOutsideReviewRepository([home!, infra!], {
      name: "infra",
      root: "/code/infra",
    });
    const outside = repositories[2]!;

    expect(repositories).toHaveLength(3);
    expect(outside).toEqual({ name: "infra", cwd: "/code/infra", history: null });
    expect(checkpointsForReviewRepository([summary(1)], outside)).toEqual([]);
    expect(
      resolveReviewRepository(
        repositories,
        `${reviewRepositorySectionPrefix(outside)}git:working-tree`,
      ),
    ).toBe(outside);
    // A root the thread already reviews is not listed twice.
    expect(withOutsideReviewRepository(repositories, { name: "app", root: "/tasks/fix/app" })).toBe(
      repositories,
    );
  });
});

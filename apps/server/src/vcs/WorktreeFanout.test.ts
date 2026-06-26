import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { GitCommandError, type VcsCreateWorktreeInput } from "@t3tools/contracts";

import {
  createThreadWorktrees,
  removeThreadWorktrees,
  worktreePlacement,
  type WorktreeFanoutDeps,
} from "./WorktreeFanout.ts";

const WORKTREES_DIR = "/t3/worktrees";
const PROJECT_ID = "project-1";
const THREAD_ID = "thread-1";

interface Recorder {
  readonly created: string[];
  readonly removed: string[];
}

function makeDeps(options?: { readonly failOnCwd?: string }): {
  deps: WorktreeFanoutDeps;
  recorder: Recorder;
} {
  const recorder: Recorder = { created: [], removed: [] };
  const deps: WorktreeFanoutDeps = {
    createWorktree: (input: VcsCreateWorktreeInput) =>
      options?.failOnCwd === input.cwd
        ? Effect.fail(
            new GitCommandError({
              operation: "createWorktree",
              command: "git worktree add",
              cwd: input.cwd,
              detail: "injected failure",
            }),
          )
        : Effect.sync(() => {
            recorder.created.push(input.path ?? "");
            return {
              worktree: {
                path: input.path ?? "",
                refName: input.newRefName ?? input.refName,
              },
            };
          }),
    removeWorktree: (input) =>
      Effect.sync(() => {
        recorder.removed.push(input.path);
      }),
  };
  return { deps, recorder };
}

describe("worktreePlacement", () => {
  it("groups worktrees under <worktreesDir>/<projectId>/<threadId>/<repoName>", () => {
    expect(
      worktreePlacement({
        worktreesDir: WORKTREES_DIR,
        projectId: PROJECT_ID,
        threadId: THREAD_ID,
        repoRoot: "/Users/me/work/backend",
      }),
    ).toBe("/t3/worktrees/project-1/thread-1/backend");
  });

  it("disambiguates colliding repo basenames", () => {
    expect(
      worktreePlacement({
        worktreesDir: WORKTREES_DIR,
        projectId: PROJECT_ID,
        threadId: THREAD_ID,
        repoRoot: "/Users/me/other/backend",
        takenNames: new Set(["backend"]),
      }),
    ).toBe("/t3/worktrees/project-1/thread-1/backend-2");
  });
});

describe("createThreadWorktrees", () => {
  it.effect("creates one worktree per repo root, keyed by origin", () =>
    Effect.gen(function* () {
      const { deps, recorder } = makeDeps();
      const created = yield* createThreadWorktrees(deps, {
        worktreesDir: WORKTREES_DIR,
        projectId: PROJECT_ID,
        threadId: THREAD_ID,
        targets: [
          { repoRoot: "/Users/me/backend", baseRef: "main", newBranch: "t3/run" },
          { repoRoot: "/Users/me/frontend", baseRef: "develop", newBranch: "t3/run" },
        ],
      });

      expect(created).toEqual([
        {
          repoRoot: "/Users/me/backend",
          worktreePath: "/t3/worktrees/project-1/thread-1/backend",
          refName: "t3/run",
        },
        {
          repoRoot: "/Users/me/frontend",
          worktreePath: "/t3/worktrees/project-1/thread-1/frontend",
          refName: "t3/run",
        },
      ]);
      expect(recorder.created).toHaveLength(2);
      expect(recorder.removed).toHaveLength(0);
    }),
  );

  it.effect("rolls back already-created worktrees on partial failure", () =>
    Effect.gen(function* () {
      const { deps, recorder } = makeDeps({ failOnCwd: "/Users/me/frontend" });
      const result = yield* createThreadWorktrees(deps, {
        worktreesDir: WORKTREES_DIR,
        projectId: PROJECT_ID,
        threadId: THREAD_ID,
        targets: [
          { repoRoot: "/Users/me/backend", baseRef: "main", newBranch: "t3/run" },
          { repoRoot: "/Users/me/frontend", baseRef: "develop", newBranch: "t3/run" },
          { repoRoot: "/Users/me/shared", baseRef: "main", newBranch: "t3/run" },
        ],
      }).pipe(Effect.flip);

      expect(result).toBeInstanceOf(GitCommandError);
      // backend was created before frontend failed; it must be force-removed.
      expect(recorder.created).toEqual(["/t3/worktrees/project-1/thread-1/backend"]);
      expect(recorder.removed).toEqual(["/t3/worktrees/project-1/thread-1/backend"]);
    }),
  );
});

describe("removeThreadWorktrees", () => {
  it.effect("removes every fanned-out worktree", () =>
    Effect.gen(function* () {
      const { deps, recorder } = makeDeps();
      yield* removeThreadWorktrees(deps, {
        worktrees: [
          { repoRoot: "/Users/me/backend", worktreePath: "/t3/worktrees/p/t/backend" },
          { repoRoot: "/Users/me/frontend", worktreePath: "/t3/worktrees/p/t/frontend" },
        ],
        force: true,
      });

      expect(recorder.removed).toEqual(["/t3/worktrees/p/t/backend", "/t3/worktrees/p/t/frontend"]);
    }),
  );
});

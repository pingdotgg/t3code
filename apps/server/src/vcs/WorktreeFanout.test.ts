import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";

import { GitCommandError, type VcsCreateWorktreeInput } from "@t3tools/contracts";

import * as GitWorkflowService from "../git/GitWorkflowService.ts";

import {
  createThreadWorktrees,
  removeThreadWorktrees,
  worktreePlacement,
} from "./WorktreeFanout.ts";

const WORKTREES_DIR = "/t3/worktrees";
const PROJECT_ID = "project-1";
const THREAD_ID = "thread-1";

interface Recorder {
  readonly created: string[];
  readonly removed: string[];
  readonly deletedBranches: string[];
}

function makeGitWorkflowLayer(options?: {
  readonly failOnCwd?: string;
  readonly failRemovePaths?: ReadonlySet<string>;
}) {
  const recorder: Recorder = { created: [], removed: [], deletedBranches: [] };
  const service = {
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
      Effect.gen(function* () {
        recorder.removed.push(input.path);
        if (options?.failRemovePaths?.has(input.path)) {
          return yield* new GitCommandError({
            operation: "removeWorktree",
            command: "git worktree remove",
            cwd: input.cwd,
            detail: "injected removal failure",
          });
        }
      }),
    deleteBranch: (input) =>
      Effect.sync(() => {
        recorder.deletedBranches.push(`${input.cwd}:${input.branch}`);
      }),
  } satisfies Partial<GitWorkflowService.GitWorkflowService["Service"]>;
  return {
    layer: Layer.mock(GitWorkflowService.GitWorkflowService)(service),
    recorder,
  };
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
      const { layer, recorder } = makeGitWorkflowLayer();
      const created = yield* createThreadWorktrees({
        worktreesDir: WORKTREES_DIR,
        projectId: PROJECT_ID,
        threadId: THREAD_ID,
        targets: [
          { repoRoot: "/Users/me/backend", baseRef: "main", newBranch: "t3/run" },
          { repoRoot: "/Users/me/frontend", baseRef: "develop", newBranch: "t3/run" },
        ],
      }).pipe(Effect.provide(layer));

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
      const { layer, recorder } = makeGitWorkflowLayer({ failOnCwd: "/Users/me/frontend" });
      const result = yield* createThreadWorktrees({
        worktreesDir: WORKTREES_DIR,
        projectId: PROJECT_ID,
        threadId: THREAD_ID,
        targets: [
          { repoRoot: "/Users/me/backend", baseRef: "main", newBranch: "t3/run" },
          { repoRoot: "/Users/me/frontend", baseRef: "develop", newBranch: "t3/run" },
          { repoRoot: "/Users/me/shared", baseRef: "main", newBranch: "t3/run" },
        ],
      }).pipe(Effect.provide(layer), Effect.flip);

      expect(result).toBeInstanceOf(GitCommandError);
      // backend was created before frontend failed; it must be force-removed.
      expect(recorder.created).toEqual(["/t3/worktrees/project-1/thread-1/backend"]);
      expect(recorder.removed).toEqual(["/t3/worktrees/project-1/thread-1/backend"]);
      expect(recorder.deletedBranches).toEqual(["/Users/me/backend:t3/run"]);
    }),
  );

  it.effect("rolls back already-created worktrees when creation is interrupted", () =>
    Effect.gen(function* () {
      const secondCreateStarted = yield* Deferred.make<void>();
      const recorder: Recorder = { created: [], removed: [], deletedBranches: [] };
      const layer = Layer.mock(GitWorkflowService.GitWorkflowService)({
        createWorktree: (input) =>
          input.cwd === "/Users/me/frontend"
            ? Deferred.succeed(secondCreateStarted, undefined).pipe(Effect.andThen(Effect.never))
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
        deleteBranch: (input) =>
          Effect.sync(() => {
            recorder.deletedBranches.push(`${input.cwd}:${input.branch}`);
          }),
      } satisfies Partial<GitWorkflowService.GitWorkflowService["Service"]>);
      const fiber = yield* createThreadWorktrees({
        worktreesDir: WORKTREES_DIR,
        projectId: PROJECT_ID,
        threadId: THREAD_ID,
        targets: [
          { repoRoot: "/Users/me/backend", baseRef: "main", newBranch: "t3/run" },
          { repoRoot: "/Users/me/frontend", baseRef: "develop", newBranch: "t3/run" },
        ],
      }).pipe(Effect.provide(layer), Effect.forkChild);

      yield* Deferred.await(secondCreateStarted);
      yield* Fiber.interrupt(fiber);

      expect(recorder.removed).toEqual(["/t3/worktrees/project-1/thread-1/backend"]);
      expect(recorder.deletedBranches).toEqual(["/Users/me/backend:t3/run"]);
    }),
  );
});

describe("removeThreadWorktrees", () => {
  it.effect("removes every fanned-out worktree", () =>
    Effect.gen(function* () {
      const { layer, recorder } = makeGitWorkflowLayer();
      yield* removeThreadWorktrees({
        worktrees: [
          { repoRoot: "/Users/me/backend", worktreePath: "/t3/worktrees/p/t/backend" },
          { repoRoot: "/Users/me/frontend", worktreePath: "/t3/worktrees/p/t/frontend" },
        ],
        force: true,
      }).pipe(Effect.provide(layer));

      expect(recorder.removed).toEqual(["/t3/worktrees/p/t/backend", "/t3/worktrees/p/t/frontend"]);
    }),
  );

  it.effect("attempts every removal and then surfaces the first failure", () =>
    Effect.gen(function* () {
      const firstPath = "/t3/worktrees/p/t/backend";
      const { layer, recorder } = makeGitWorkflowLayer({
        failRemovePaths: new Set([firstPath]),
      });
      const error = yield* removeThreadWorktrees({
        worktrees: [
          { repoRoot: "/Users/me/backend", worktreePath: firstPath },
          { repoRoot: "/Users/me/frontend", worktreePath: "/t3/worktrees/p/t/frontend" },
        ],
        force: true,
      }).pipe(Effect.provide(layer), Effect.flip);

      expect(error).toBeInstanceOf(GitCommandError);
      expect(recorder.removed).toEqual([firstPath, "/t3/worktrees/p/t/frontend"]);
    }),
  );
});

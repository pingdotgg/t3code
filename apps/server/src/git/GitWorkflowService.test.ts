import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, expect, it, vi } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { GitCommandError, VcsRepositoryDetectionError } from "@t3tools/contracts";

import * as GitManager from "./GitManager.ts";
import * as GitWorkflowService from "./GitWorkflowService.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as WorktreeCommands from "../vcs/WorktreeCommands.ts";

/** Only `kind` reaches the Git guard; the rest of the handle never does. */
function handleFor(kind: "git" | "jj"): VcsDriverRegistry.VcsDriverHandle {
  return { kind } as unknown as VcsDriverRegistry.VcsDriverHandle;
}

function layer(input: {
  readonly detect: VcsDriverRegistry.VcsDriverRegistry["Service"]["detect"];
  readonly resolve?: VcsDriverRegistry.VcsDriverRegistry["Service"]["resolve"];
  readonly git?: Partial<GitVcsDriver.GitVcsDriver["Service"]>;
  readonly gitManager?: Partial<GitManager.GitManager["Service"]>;
  readonly worktreeCommands?: Partial<WorktreeCommands.WorktreeCommands["Service"]>;
}) {
  return GitWorkflowService.layer.pipe(
    Layer.provide(
      Layer.mock(WorktreeCommands.WorktreeCommands)({
        resolve: () => Effect.succeed({ create: "", remove: "" }),
        ...input.worktreeCommands,
      }),
    ),
    Layer.provide(NodeServices.layer),
    Layer.provide(
      Layer.mock(VcsDriverRegistry.VcsDriverRegistry)({
        detect: input.detect,
        ...(input.resolve ? { resolve: input.resolve } : {}),
      }),
    ),
    Layer.provide(Layer.mock(GitVcsDriver.GitVcsDriver)(input.git ?? {})),
    Layer.provide(Layer.mock(GitManager.GitManager)(input.gitManager ?? {})),
  );
}

describe("GitWorkflowService", () => {
  it.effect("reports a non-Git VCS repository as not a Git repository", () =>
    Effect.gen(function* () {
      const workflow = yield* GitWorkflowService.GitWorkflowService;
      const isRepository = yield* workflow.isRepository("/jj-repo");

      assert.equal(isRepository, false);
    }).pipe(
      Effect.provide(
        layer({
          detect: () =>
            Effect.succeed({
              kind: "jj",
              repository: {
                kind: "jj",
                rootPath: "/jj-repo",
                metadataPath: "/jj-repo/.jj",
                freshness: {
                  source: "live-local",
                  observedAt: DateTime.makeUnsafe("2026-01-01T00:00:00.000Z"),
                  expiresAt: Option.none(),
                },
              },
              driver: {} as VcsDriverRegistry.VcsDriverHandle["driver"],
            }),
        }),
      ),
    ),
  );

  it.effect("returns an empty local status when no VCS repository is detected", () =>
    Effect.gen(function* () {
      const workflow = yield* GitWorkflowService.GitWorkflowService;
      const status = yield* workflow.localStatus({ cwd: "/not-a-repo" });

      assert.deepStrictEqual(status, {
        isRepo: false,
        hasPrimaryRemote: false,
        isDefaultRef: false,
        refName: null,
        hasWorkingTreeChanges: false,
        workingTree: {
          files: [],
          insertions: 0,
          deletions: 0,
        },
      });
    }).pipe(
      Effect.provide(
        layer({
          detect: () => Effect.succeed(null),
        }),
      ),
    ),
  );

  it.effect("returns an empty full status when no VCS repository is detected", () =>
    Effect.gen(function* () {
      const workflow = yield* GitWorkflowService.GitWorkflowService;
      const status = yield* workflow.status({ cwd: "/not-a-repo" });

      assert.deepStrictEqual(status, {
        isRepo: false,
        hasPrimaryRemote: false,
        isDefaultRef: false,
        refName: null,
        hasWorkingTreeChanges: false,
        workingTree: {
          files: [],
          insertions: 0,
          deletions: 0,
        },
        hasUpstream: false,
        aheadCount: 0,
        behindCount: 0,
        aheadOfDefaultCount: 0,
        pr: null,
      });
    }).pipe(
      Effect.provide(
        layer({
          detect: () => Effect.succeed(null),
        }),
      ),
    ),
  );

  it.effect("does not call GitManager status methods when no VCS repository is detected", () => {
    const localStatus = vi.fn();
    const remoteStatus = vi.fn();
    const status = vi.fn();

    const layerTest = layer({
      detect: () => Effect.succeed(null),
      gitManager: { localStatus, remoteStatus, status },
    });

    return Effect.gen(function* () {
      const workflow = yield* GitWorkflowService.GitWorkflowService;
      yield* workflow.localStatus({ cwd: "/not-a-repo" });
      yield* workflow.remoteStatus({ cwd: "/not-a-repo" });
      yield* workflow.status({ cwd: "/not-a-repo" });

      assert.equal(localStatus.mock.calls.length, 0);
      assert.equal(remoteStatus.mock.calls.length, 0);
      assert.equal(status.mock.calls.length, 0);
    }).pipe(Effect.provide(layerTest));
  });

  it.effect("returns an empty ref list when no VCS repository is detected", () =>
    Effect.gen(function* () {
      const workflow = yield* GitWorkflowService.GitWorkflowService;
      const refs = yield* workflow.listRefs({ cwd: "/not-a-repo" });

      assert.deepStrictEqual(refs, {
        refs: [],
        isRepo: false,
        hasPrimaryRemote: false,
        nextCursor: null,
        totalCount: 0,
      });
    }).pipe(
      Effect.provide(
        layer({
          detect: () => Effect.succeed(null),
        }),
      ),
    ),
  );

  it.effect("structures workflow detection failures without exposing upstream details", () => {
    const cause = new VcsRepositoryDetectionError({
      operation: "VcsDriverRegistry.detect",
      cwd: "/repo",
      detail: "upstream detail must stay in the cause chain",
    });

    return Effect.gen(function* () {
      const workflow = yield* GitWorkflowService.GitWorkflowService;
      const error = yield* workflow.status({ cwd: "/repo" }).pipe(Effect.flip);

      expect(error).toMatchObject({
        _tag: "GitManagerError",
        operation: "GitWorkflowService.status",
        cwd: "/repo",
        detail: "Failed to detect a VCS repository for this Git workflow.",
      });
      expect(error.message).not.toContain(cause.detail);
    }).pipe(
      Effect.provide(
        layer({
          detect: () => Effect.fail(cause),
        }),
      ),
    );
  });

  it.effect("structures command detection failures without exposing upstream details", () => {
    const cause = new VcsRepositoryDetectionError({
      operation: "VcsDriverRegistry.detect",
      cwd: "/repo",
      detail: "upstream command detail must stay in the cause chain",
    });

    return Effect.gen(function* () {
      const workflow = yield* GitWorkflowService.GitWorkflowService;
      const error = yield* workflow.listRefs({ cwd: "/repo" }).pipe(Effect.flip);

      expect(error).toMatchObject({
        _tag: "GitCommandError",
        operation: "GitWorkflowService.listRefs",
        command: "vcs-route",
        cwd: "/repo",
        detail: "Failed to detect a VCS repository for this Git command.",
      });
      expect(error.message).not.toContain(cause.detail);
    }).pipe(
      Effect.provide(
        layer({
          detect: () => Effect.fail(cause),
        }),
      ),
    );
  });

  describe("custom worktree commands", () => {
    const gitStatus = (stdout: string) =>
      Effect.succeed({
        exitCode: 0,
        stdout,
        stderr: "",
        stdoutTruncated: false,
        stderrTruncated: false,
      } as GitVcsDriver.ExecuteGitResult);

    it.effect("hands the create command to the driver as its checkout step", () => {
      const run = vi.fn(
        (_input: Parameters<WorktreeCommands.WorktreeCommands["Service"]["run"]>[0]) =>
          Effect.succeed(""),
      );

      return Effect.gen(function* () {
        const workflow = yield* GitWorkflowService.GitWorkflowService;
        yield* workflow.createWorktree({
          cwd: "/repo",
          refName: "main",
          newRefName: "t3/feature",
          path: null,
        });

        assert.equal(run.mock.calls.length, 1);
        const [call] = run.mock.calls[0]!;
        assert.equal(call.command, "make-worktree");
        assert.equal(call.projectCwd, "/repo");
        assert.deepStrictEqual(call.env, {
          T3CODE_PROJECT_ROOT: "/repo",
          T3CODE_WORKTREE_PATH: "/worktrees/repo/t3-feature",
          T3CODE_BRANCH: "t3/feature",
          T3CODE_START_REF: "main",
          T3CODE_CREATE_BRANCH: "1",
        });
      }).pipe(
        Effect.provide(
          layer({
            detect: () => Effect.succeed(handleFor("git")),
            resolve: () => Effect.succeed(handleFor("git")),
            gitManager: {
              createWorktree: (_input, options) =>
                (
                  options?.customCheckout?.({
                    worktreePath: "/worktrees/repo/t3-feature",
                    branch: "t3/feature",
                    startRef: "main",
                    createBranch: true,
                  }) ?? Effect.succeed(null)
                ).pipe(
                  Effect.as({
                    worktree: { path: "/worktrees/repo/t3-feature", refName: "t3/feature" },
                  }),
                ),
            },
            worktreeCommands: {
              resolve: () => Effect.succeed({ create: "make-worktree", remove: "" }),
              run,
            },
          }),
        ),
      );
    });

    it.effect("runs the remove command instead of the built-in step and prunes after it", () => {
      const gitRemoveWorktree = vi.fn(() => Effect.void);
      const pruneWorktrees = vi.fn(() => Effect.void);

      return Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        // A child of the scoped temp dir, so the scope's own cleanup survives the removal.
        const worktreePath = `${yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-custom-rm-" })}/worktree`;
        yield* fileSystem.makeDirectory(worktreePath);
        const workflow = yield* GitWorkflowService.GitWorkflowService.pipe(
          Effect.provide(
            layer({
              detect: () => Effect.succeed(handleFor("git")),
              resolve: () => Effect.succeed(handleFor("git")),
              git: {
                execute: () => gitStatus(""),
                removeWorktree: gitRemoveWorktree,
                pruneWorktrees,
              },
              worktreeCommands: {
                resolve: () => Effect.succeed({ create: "", remove: "drop-worktree" }),
                run: ({ env }) =>
                  fileSystem
                    .remove(env.T3CODE_WORKTREE_PATH!, { recursive: true })
                    .pipe(Effect.as(""), Effect.orDie),
              },
            }),
          ),
        );

        yield* workflow.removeWorktree({ cwd: "/repo", path: worktreePath });

        assert.equal(gitRemoveWorktree.mock.calls.length, 0);
        assert.equal(pruneWorktrees.mock.calls.length, 1);
      }).pipe(Effect.provide(NodeServices.layer));
    });

    it.effect("refuses to remove a git worktree with changes unless forced", () => {
      const run = vi.fn(() => Effect.succeed(""));

      return Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const worktreePath = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-custom-rm-" });
        const workflow = yield* GitWorkflowService.GitWorkflowService.pipe(
          Effect.provide(
            layer({
              detect: () => Effect.succeed(handleFor("git")),
              resolve: () => Effect.succeed(handleFor("git")),
              git: { execute: () => gitStatus(" M src/index.ts\n") },
              worktreeCommands: {
                resolve: () => Effect.succeed({ create: "", remove: "drop-worktree" }),
                run,
              },
            }),
          ),
        );

        const exit = yield* Effect.exit(
          workflow.removeWorktree({ cwd: "/repo", path: worktreePath }),
        );

        assert.isTrue(Exit.isFailure(exit));
        assert.equal(run.mock.calls.length, 0);
      }).pipe(Effect.provide(NodeServices.layer));
    });

    it.effect("fails when the remove command leaves the worktree in place", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const worktreePath = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-custom-rm-" });
        const workflow = yield* GitWorkflowService.GitWorkflowService.pipe(
          Effect.provide(
            layer({
              detect: () => Effect.succeed(handleFor("git")),
              resolve: () => Effect.succeed(handleFor("git")),
              worktreeCommands: {
                resolve: () => Effect.succeed({ create: "", remove: "true" }),
                run: () => Effect.succeed(""),
              },
            }),
          ),
        );

        const error = yield* Effect.flip(
          workflow.removeWorktree({ cwd: "/repo", path: worktreePath, force: true }),
        );

        assert.instanceOf(error, GitCommandError);
        expect(error.detail).toContain("left");
      }).pipe(Effect.provide(NodeServices.layer)),
    );
  });
});

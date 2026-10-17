import { assert, expect, it, vi } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { ChildProcessSpawner } from "effect/process";

import {
  GitCommandError,
  VcsRepositoryDetectionError,
  VcsUnsupportedOperationError,
} from "@t3tools/contracts";

import * as NodeServices from "@effect/platform-node/NodeServices";
import * as FileSystem from "effect/FileSystem";

import * as ServerConfig from "../config.ts";
import * as JjWorkflow from "../jj/JjWorkflow.ts";
import { makeJjRemotes } from "../jj/JjRemotes.ts";
import { makeJjWorkspaces } from "../jj/JjWorkspaces.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as JjVcsDriver from "../vcs/JjVcsDriver.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as GitManager from "./GitManager.ts";
import * as GitWorkflowService from "./GitWorkflowService.ts";
import {
  describeJj,
  runJj,
  withJjRepo,
  stubSourceControlProviders,
} from "../vcs/testing/JjTestSupport.ts";
import { makeJjStatus } from "../jj/JjStatus.ts";

/** Only `kind` reaches the routing table; the rest of the handle never does. */
function handleFor(kind: "git" | "jj"): VcsDriverRegistry.VcsDriverHandle {
  return { kind } as unknown as VcsDriverRegistry.VcsDriverHandle;
}

const jjCapabilities = {
  kind: "jj",
  supportsWorktrees: false,
  supportsBookmarks: true,
  supportsAtomicSnapshot: true,
  supportsPushDefaultRemote: false,
  ignoreClassifier: "git-compatible-fallback",
} as const satisfies JjVcsDriver.JjVcsDriverShape["capabilities"];

function makeLayer(input: {
  readonly detect: VcsDriverRegistry.VcsDriverRegistry["Service"]["detect"];
  readonly resolve?: VcsDriverRegistry.VcsDriverRegistry["Service"]["resolve"];
  readonly git?: Partial<GitVcsDriver.GitVcsDriver["Service"]>;
  readonly gitManager?: Partial<GitManager.GitManager["Service"]>;
  readonly jj?: Partial<JjWorkflow.JjWorkflow["Service"]>;
  readonly jjDriver?: Partial<JjVcsDriver.JjVcsDriver["Service"]>;
}) {
  return GitWorkflowService.layer.pipe(
    Layer.provide(
      Layer.mock(VcsDriverRegistry.VcsDriverRegistry)({
        detect: input.detect,
        ...(input.resolve === undefined ? {} : { resolve: input.resolve }),
      }),
    ),
    Layer.provide(Layer.mock(GitVcsDriver.GitVcsDriver)(input.git ?? {})),
    Layer.provide(Layer.mock(GitManager.GitManager)(input.gitManager ?? {})),
    Layer.provide(Layer.mock(JjWorkflow.JjWorkflow)(input.jj ?? {})),
    Layer.provide(
      Layer.mock(JjVcsDriver.JjVcsDriver)({
        ...input.jjDriver,
        capabilities: input.jjDriver?.capabilities ?? jjCapabilities,
      }),
    ),
  );
}

describeJj("GitWorkflowService real jj currentRefName", () => {
  it.effect("reads an orphan ref name and retains broken totals command failures", () =>
    withJjRepo({ prefix: "t3-jj-orphan-ref-", seed: true }, (repo) =>
      Effect.gen(function* () {
        const gitManager = yield* GitManager.GitManager.pipe(
          Effect.provide(
            Layer.mock(GitManager.GitManager)({
              branchPullRequest: () => Effect.succeed(null),
            }),
          ),
        );
        const status = yield* makeJjStatus({
          driver: repo.driver,
          process: repo.process,
          gitManager,
          sourceControlProviders: yield* stubSourceControlProviders,
        });
        const layer = makeLayer({
          detect: () => Effect.succeed(handleFor("jj")),
          jj: { localStatus: status.localStatus },
        });
        yield* runJj(repo.root, ["new", "root()"]);
        yield* repo.fileSystem.writeFileString(repo.path.join(repo.root, "orphan.txt"), "orphan\n");
        yield* Effect.gen(function* () {
          const workflow = yield* GitWorkflowService.GitWorkflowService;
          assert.isNull(yield* workflow.currentRefName(repo.root));
          const local = yield* workflow.localStatus({ cwd: repo.root });
          assert.isUndefined(local.branchChanges);
          assert.isTrue(local.hasWorkingTreeChanges);
          // An invalid Git diff option is a genuine command error, not unrelated history.
          yield* runJj(repo.root, ["new", "main"]);
          yield* repo.fileSystem.writeFileString(
            repo.path.join(repo.root, ".git", "config"),
            (yield* repo.fileSystem.readFileString(repo.path.join(repo.root, ".git", "config"))) +
              "\n[diff]\nalgorithm = invalid-algorithm\n",
          );
          const failure = yield* workflow.currentRefName(repo.root).pipe(Effect.flip);
          assert.equal(failure._tag, "GitCommandError");
        }).pipe(Effect.provide(layer));
      }),
    ),
  );

  for (const failureAt of ["project", "workspace"] as const) {
    it.effect(`retains ${failureAt} detection failures after creating a real jj workspace`, () =>
      withJjRepo({ prefix: "t3-jj-workspace-validation-", seed: true }, (repo) =>
        Effect.gen(function* () {
          const remotes = makeJjRemotes({ driver: repo.driver, process: repo.process });
          const workspaces = makeJjWorkspaces({
            driver: repo.driver,
            process: repo.process,
            fileSystem: repo.fileSystem,
            path: repo.path,
            worktreesDir: repo.path.join(repo.base, "worktrees"),
            bookmarkTo: remotes.bookmarkTo,
          });
          const workspacePath = repo.path.join(repo.base, "workspace");
          const failureCwd = failureAt === "project" ? repo.root : workspacePath;
          const detectionFailure = new VcsRepositoryDetectionError({
            operation: "VcsDriverRegistry.detect",
            cwd: failureCwd,
            detail: "workspace detection unavailable",
          });
          let failDetection = false;
          yield* Effect.gen(function* () {
            const workflow = yield* GitWorkflowService.GitWorkflowService;
            const created = yield* workflow.createWorktree({
              cwd: repo.root,
              refName: "main",
              newRefName: "topic/validation",
              path: workspacePath,
            });
            assert.equal(created.worktree.path, workspacePath);
            assert.isTrue(yield* repo.fileSystem.exists(repo.path.join(workspacePath, ".jj")));
            failDetection = true;
            const error = yield* workflow
              .validateWorkspace(repo.root, created.worktree.path)
              .pipe(Effect.flip);
            expect(error).toMatchObject({
              _tag: "GitManagerError",
              operation: "GitWorkflowService.validateWorkspace",
              cwd: failureCwd,
              detail: "Failed to detect a VCS repository for this Git workflow.",
              cause: detectionFailure,
            });
          }).pipe(
            Effect.provide(
              makeLayer({
                detect: ({ cwd }) =>
                  failDetection && cwd === failureCwd
                    ? Effect.fail(detectionFailure)
                    : repo.driver
                        .detectRepository(cwd)
                        .pipe(
                          Effect.map((repository) =>
                            repository === null
                              ? null
                              : { kind: "jj", repository, driver: repo.driver },
                          ),
                        ),
                jj: { createWorktree: workspaces.createWorktree },
              }),
            ),
          );
        }),
      ),
    );
  }
});

it.layer(NodeServices.layer)("GitWorkflowService", (it) => {
  for (const method of ["resolveWorktreeBaseRemote", "fetchWorktreeBaseCommit"] as const) {
    it.effect(`routes jj launch ${method} without a Git-only guard`, () => {
      const input = { cwd: "/jj", refName: "main" };
      const remote = { remoteName: "upstream", branchName: "main" };
      const commit = { commitSha: "fresh", remoteRefName: "upstream/main" };
      const jjResolve = vi.fn(() => Effect.succeed(remote));
      const jjFetch = vi.fn(() => Effect.succeed(commit));
      return Effect.gen(function* () {
        const workflow = yield* GitWorkflowService.GitWorkflowService;
        assert.deepEqual(
          yield* workflow[method](input),
          method === "resolveWorktreeBaseRemote" ? remote : commit,
        );
        assert.equal(
          (method === "resolveWorktreeBaseRemote" ? jjResolve : jjFetch).mock.calls.length,
          1,
        );
      }).pipe(
        Effect.provide(makeLayer({
          detect: () => Effect.succeed(handleFor("jj")),
          jj: { resolveWorktreeBaseRemote: jjResolve, fetchWorktreeBaseCommit: jjFetch },
        })),
      );
    });

    it.effect(`retains Git launch ${method} when detection selects Git`, () =>
      Effect.gen(function* () {
        const workflow = yield* GitWorkflowService.GitWorkflowService;
        assert.isNull(yield* workflow[method]({ cwd: "/git", refName: "main" }));
      }).pipe(
        Effect.provide(makeLayer({
          detect: () => Effect.succeed(handleFor("git")),
          resolve: () => Effect.succeed(handleFor("git")),
          git: {
            resolveWorktreeBaseRemote: () => Effect.succeed(null),
            fetchWorktreeBaseCommit: () => Effect.succeed(null),
          },
        })),
      ),
    );

    it.effect(`retains unsupported-repository errors for launch ${method}`, () =>
      Effect.gen(function* () {
        const workflow = yield* GitWorkflowService.GitWorkflowService;
        let failure: GitCommandError;
        if (method === "resolveWorktreeBaseRemote") {
          failure = yield* workflow
            .resolveWorktreeBaseRemote({ cwd: "/missing", refName: "main" })
            .pipe(Effect.flip);
        } else {
          failure = yield* workflow
            .fetchWorktreeBaseCommit({ cwd: "/missing", refName: "main" })
            .pipe(Effect.flip);
        }
        assert.equal(failure._tag, "GitCommandError");
        assert.equal(failure.operation, `GitWorkflowService.${method}`);
        expect(failure).toMatchObject({ cause: { _tag: "VcsUnsupportedOperationError" } });
      }).pipe(Effect.provide(makeLayer({ detect: () => Effect.succeed(null) }))),
    );
  }

  it.effect.each([0, 1])("preserves Git commit-probe exit status %s", (exitCode) =>
    Effect.gen(function* () {
      const workflow = yield* GitWorkflowService.GitWorkflowService;
      assert.equal(
        yield* workflow.hasCommit({ cwd: "/repo", refName: "parent-commit" }),
        exitCode === 0,
      );
    }).pipe(
      Effect.provide(
        makeLayer({
          detect: () => Effect.succeed(handleFor("git")),
          git: {
            execute: (input) => {
              assert.deepEqual(input, {
                operation: "GitWorkflowService.hasCommit",
                cwd: "/repo",
                args: ["rev-parse", "--verify", "parent-commit^{commit}"],
                allowNonZeroExit: true,
              });
              return Effect.succeed({
                exitCode: ChildProcessSpawner.ExitCode(exitCode),
                stdout: "",
                stderr: "",
                stdoutTruncated: false,
                stderrTruncated: false,
              });
            },
          },
        }),
      ),
    ),
  );

  it.effect("preserves Git commit-probe process failures", () => {
    const cause = new GitCommandError({
      operation: "GitWorkflowService.hasCommit",
      command: "git rev-parse",
      cwd: "/repo",
      detail: "Git process could not be started.",
    });
    return Effect.gen(function* () {
      const workflow = yield* GitWorkflowService.GitWorkflowService;
      assert.strictEqual(
        yield* workflow.hasCommit({ cwd: "/repo", refName: "parent-commit" }).pipe(Effect.flip),
        cause,
      );
    }).pipe(
      Effect.provide(
        makeLayer({
          detect: () => Effect.succeed(handleFor("git")),
          git: { execute: () => Effect.fail(cause) },
        }),
      ),
    );
  });

  const detectionFailure = new VcsRepositoryDetectionError({
    operation: "VcsDriverRegistry.detect",
    cwd: "/repo",
    detail: "private detection detail",
  });

  for (const detected of ["git", "jj", "missing", "failure"] as const) {
    for (const method of [
      "invalidateLocalStatus",
      "invalidateRemoteStatus",
      "invalidateStatus",
    ] as const) {
      it.effect(
        `routes ${method} to ${detected === "jj" ? "jj" : "git"} for ${detected} detection`,
        () => {
          const gitInvalidate = vi.fn(() => Effect.void);
          const jjInvalidate = vi.fn(() => Effect.void);
          return Effect.gen(function* () {
            const workflow = yield* GitWorkflowService.GitWorkflowService;
            yield* workflow[method]("/repo");
            expect(
              detected === "jj" ? jjInvalidate : gitInvalidate,
            ).toHaveBeenCalledExactlyOnceWith("/repo");
            expect(detected === "jj" ? gitInvalidate : jjInvalidate).not.toHaveBeenCalled();
          }).pipe(
            Effect.provide(
              makeLayer({
                detect: () =>
                  detected === "failure"
                    ? Effect.fail(detectionFailure)
                    : Effect.succeed(detected === "missing" ? null : handleFor(detected)),
                gitManager: { [method]: gitInvalidate },
                jj: { [method]: jjInvalidate },
              }),
            ),
          );
        },
      );
    }
  }

  for (const detected of ["git", "unknown", "missing", "failure"] as const) {
    it.effect(`preserves original Git facade behavior for ${detected} detection`, () => {
      const resolveCommit = vi.fn(() => Effect.succeed({ commitSha: "git-head" }));
      const resolveBranchName = vi.fn(() => Effect.succeed("topic"));
      const listWorktreePaths = vi.fn(() => Effect.succeed(["/repo", "/git-worktree"]));
      return Effect.gen(function* () {
        const workflow = yield* GitWorkflowService.GitWorkflowService;
        assert.equal(yield* workflow.providerCwd("/repo"), "/repo");
        assert.equal(yield* workflow.committedBase("/repo"), "git-head");
        assert.deepEqual(yield* workflow.listWorkspacePaths("/repo"), ["/repo", "/git-worktree"]);
        assert.equal(yield* workflow.currentRefName("/repo"), "topic");
        if (detected !== "failure") {
          assert.equal(yield* workflow.validateWorkspace("/repo", "/workspace"), true);
          assert.equal(yield* workflow.validateWorkspace("/repo", null), true);
        }
        expect(resolveCommit).toHaveBeenCalledExactlyOnceWith({ cwd: "/repo", revision: "HEAD" });
        expect(resolveBranchName).toHaveBeenCalledExactlyOnceWith("/repo", "HEAD");
        expect(listWorktreePaths).toHaveBeenCalledExactlyOnceWith("/repo");
      }).pipe(
        Effect.provide(
          makeLayer({
            detect: (input) => {
              assert.equal(input.jjOnly, true);
              return detected === "failure"
                ? Effect.fail(detectionFailure)
                : Effect.succeed(
                    detected === "missing" ? null : { ...handleFor("git"), kind: detected },
                  );
            },
            git: { resolveCommit, resolveBranchName, listWorktreePaths },
          }),
        ),
      );
    });
  }
  it.effect(
    "preserves Git command errors and tolerates Git workspace listing failure after detection fallback",
    () => {
      const cause = new GitCommandError({
        operation: "git-original",
        command: "git rev-parse",
        cwd: "/repo",
        detail: "original Git failure",
      });
      return Effect.gen(function* () {
        const workflow = yield* GitWorkflowService.GitWorkflowService;
        assert.strictEqual(yield* workflow.committedBase("/repo").pipe(Effect.flip), cause);
        assert.deepEqual(yield* workflow.listWorkspacePaths("/repo"), []);
        assert.strictEqual(yield* workflow.currentRefName("/repo").pipe(Effect.flip), cause);
      }).pipe(
        Effect.provide(
          makeLayer({
            detect: () => Effect.fail(detectionFailure),
            git: {
              resolveCommit: () => Effect.fail(cause),
              listWorktreePaths: () => Effect.fail(cause),
              resolveBranchName: () => Effect.fail(cause),
            },
          }),
        ),
      );
    },
  );

  it.effect("preserves a detached Git ref name after detection fallback", () =>
    Effect.gen(function* () {
      const workflow = yield* GitWorkflowService.GitWorkflowService;
      assert.equal(yield* workflow.currentRefName("/repo"), null);
    }).pipe(
      Effect.provide(
        makeLayer({
          detect: () => Effect.fail(detectionFailure),
          git: { resolveBranchName: () => Effect.succeed(null) },
        }),
      ),
    ),
  );

  it.effect(
    "uses the main jj workspace for providers and the parent change as committed base",
    () => {
      const ensureUsable = vi.fn(() =>
        Effect.succeed({
          mainWorkspaceRoot: "/main",
          workspaceRoot: "/workspace",
          gitDir: "/main/.git",
          isSecondaryWorkspace: true,
        }),
      );
      const changeAt = vi.fn(() =>
        Effect.succeed({
          commitId: "jj-parent",
          parentCommitIds: [],
          description: "",
          empty: false,
          conflict: false,
          localBookmarks: [],
          fileStats: [],
        }),
      );
      return Effect.gen(function* () {
        const workflow = yield* GitWorkflowService.GitWorkflowService;
        assert.equal(yield* workflow.providerCwd("/workspace"), "/main");
        assert.equal(yield* workflow.committedBase("/workspace"), "jj-parent");
        expect(ensureUsable).toHaveBeenCalledExactlyOnceWith(
          "GitWorkflowService.providerCwd",
          "/workspace",
        );
        expect(changeAt).toHaveBeenCalledExactlyOnceWith("/workspace", "@-");
      }).pipe(
        Effect.provide(
          makeLayer({
            detect: () => Effect.succeed(handleFor("jj")),
            jjDriver: { ensureUsable, changeAt },
          }),
        ),
      );
    },
  );

  it.effect("returns no committed base when the jj parent is root", () =>
    Effect.gen(function* () {
      const workflow = yield* GitWorkflowService.GitWorkflowService;
      assert.equal(yield* workflow.committedBase("/repo"), null);
    }).pipe(
      Effect.provide(
        makeLayer({
          detect: () => Effect.succeed(handleFor("jj")),
          jjDriver: { changeAt: () => Effect.succeed(null) },
        }),
      ),
    ),
  );

  for (const gitFails of [false, true]) {
    it.effect(`lists jj workspace roots alongside Git worktrees (Git failure: ${gitFails})`, () =>
      Effect.gen(function* () {
        const workflow = yield* GitWorkflowService.GitWorkflowService;
        assert.deepEqual(
          yield* workflow.listWorkspacePaths("/repo"),
          gitFails ? ["/repo", "/jj-workspace"] : ["/repo", "/jj-workspace", "/git-worktree"],
        );
      }).pipe(
        Effect.provide(
          makeLayer({
            detect: () => Effect.succeed(handleFor("jj")),
            jjDriver: {
              listWorkspaces: () =>
                Effect.succeed([
                  { name: "default", root: "/repo" },
                  { name: "topic", root: "/jj-workspace" },
                ]),
            },
            git: {
              listWorktreePaths: () =>
                gitFails
                  ? Effect.fail(
                      new GitCommandError({
                        operation: "test",
                        command: "git worktree list",
                        cwd: "/repo",
                        detail: "unavailable",
                      }),
                    )
                  : Effect.succeed(["/repo", "/git-worktree"]),
            },
          }),
        ),
      ),
    );
  }

  for (const refName of ["topic", null]) {
    it.effect(`returns the jj local status ref name ${refName}`, () =>
      Effect.gen(function* () {
        const workflow = yield* GitWorkflowService.GitWorkflowService;
        assert.equal(yield* workflow.currentRefName("/repo"), refName);
      }).pipe(
        Effect.provide(
          makeLayer({
            detect: () => Effect.succeed(handleFor("jj")),
            jj: {
              localStatus: () =>
                Effect.succeed({
                  isRepo: true,
                  refName,
                  hasPrimaryRemote: false,
                  isDefaultRef: false,
                  hasWorkingTreeChanges: false,
                  workingTree: { files: [], insertions: 0, deletions: 0 },
                }),
            },
          }),
        ),
      ),
    );
  }

  for (const workspace of ["separate", "same-root", "git", "missing"] as const) {
    it.effect(`validates a detected jj project's ${workspace} workspace`, () =>
      Effect.gen(function* () {
        const workflow = yield* GitWorkflowService.GitWorkflowService;
        assert.equal(
          yield* workflow.validateWorkspace("/repo", "/workspace"),
          workspace === "separate",
        );
        assert.equal(yield* workflow.validateWorkspace("/repo", null), false);
      }).pipe(
        Effect.provide(
          makeLayer({
            detect: ({ cwd }) => {
              if (cwd === "/workspace" && workspace === "missing") return Effect.succeed(null);
              return Effect.succeed({
                ...handleFor(cwd === "/workspace" && workspace === "git" ? "git" : "jj"),
                repository: {
                  rootPath:
                    cwd === "/workspace" && workspace !== "same-root" ? "/workspace" : "/repo",
                },
              } as VcsDriverRegistry.VcsDriverHandle);
            },
          }),
        ),
      ),
    );
  }

  it.effect("wraps jj driver failures with static facade details and preserves their causes", () =>
    Effect.gen(function* () {
      const workflow = yield* GitWorkflowService.GitWorkflowService;
      const providerError = yield* workflow.providerCwd("/repo").pipe(Effect.flip);
      const baseError = yield* workflow.committedBase("/repo").pipe(Effect.flip);
      const pathsError = yield* workflow.listWorkspacePaths("/repo").pipe(Effect.flip);
      for (const [error, tag, detail] of [
        [providerError, "GitManagerError", "Failed to resolve the provider working directory."],
        [baseError, "GitCommandError", "Failed to resolve the committed base."],
        [pathsError, "GitCommandError", "Failed to list workspace paths."],
      ] as const) {
        expect(error).toMatchObject({ _tag: tag, cwd: "/repo", detail, cause: detectionFailure });
        expect(error.message).not.toContain(detectionFailure.detail);
      }
    }).pipe(
      Effect.provide(
        makeLayer({
          detect: () => Effect.succeed(handleFor("jj")),
          jjDriver: {
            ensureUsable: () => Effect.fail(detectionFailure),
            changeAt: () => Effect.fail(detectionFailure),
            listWorkspaces: () => Effect.fail(detectionFailure),
          },
        }),
      ),
    ),
  );

  it.effect("keeps the upstream ref-list detection failure message", () =>
    Effect.gen(function* () {
      const workflow = yield* GitWorkflowService.GitWorkflowService;
      const error = yield* workflow.listRefs({ cwd: "/repo" }).pipe(Effect.flip);
      expect(error).toMatchObject({
        _tag: "GitCommandError",
        detail: "Failed to detect a VCS repository for this Git command.",
        cause: detectionFailure,
      });
      expect(error.message).not.toContain(detectionFailure.detail);
    }).pipe(Effect.provide(makeLayer({ detect: () => Effect.fail(detectionFailure) }))),
  );

  it.effect("reports a supported Jujutsu workspace as a repository", () =>
    Effect.gen(function* () {
      const workflow = yield* GitWorkflowService.GitWorkflowService;
      const isRepository = yield* workflow.isRepository("/jj-repo");

      assert.equal(isRepository, true);
    }).pipe(
      Effect.provide(
        makeLayer({
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

  for (const kind of ["git", "unknown", null] as const) {
    it.effect(`reports repository containment for ${kind}`, () =>
      Effect.gen(function* () {
        const workflow = yield* GitWorkflowService.GitWorkflowService;
        assert.equal(yield* workflow.isRepository("/repo"), kind === "git");
      }).pipe(
        Effect.provide(
          makeLayer({
            detect: () => Effect.succeed(kind === null ? null : { ...handleFor("git"), kind }),
          }),
        ),
      ),
    );
  }

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
        makeLayer({
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
        makeLayer({
          detect: () => Effect.succeed(null),
        }),
      ),
    ),
  );

  it.effect("does not call either lane's status methods when no repository is detected", () => {
    const localStatus = vi.fn();
    const remoteStatus = vi.fn();
    const status = vi.fn();
    const statusMethods = { localStatus, remoteStatus, status };

    return Effect.gen(function* () {
      const workflow = yield* GitWorkflowService.GitWorkflowService;
      yield* workflow.localStatus({ cwd: "/not-a-repo" });
      yield* workflow.remoteStatus({ cwd: "/not-a-repo" });
      yield* workflow.status({ cwd: "/not-a-repo" });

      assert.equal(localStatus.mock.calls.length, 0);
      assert.equal(remoteStatus.mock.calls.length, 0);
      assert.equal(status.mock.calls.length, 0);
    }).pipe(
      Effect.provide(
        makeLayer({
          detect: () => Effect.succeed(null),
          gitManager: statusMethods,
          jj: statusMethods,
        }),
      ),
    );
  });

  it.effect(
    "creates Git worktrees through GitManager and Jujutsu workspaces through JjWorkflow",
    () => {
      const result = { worktree: { path: "/worktrees/topic", refName: "topic" } };
      const gitCreateWorktree = vi.fn(() => Effect.succeed(result));
      const jjCreateWorktree = vi.fn(() => Effect.succeed(result));
      const progress = { onSubmodulesStarted: vi.fn(() => Effect.void) };
      const options = { progress };
      const gitInput = {
        cwd: "/git-repo",
        refName: "main",
        newRefName: "topic",
        path: "/worktrees/topic",
      };
      const jjInput = { ...gitInput, cwd: "/jj-repo" };

      return Effect.gen(function* () {
        const workflow = yield* GitWorkflowService.GitWorkflowService;
        assert.deepEqual(yield* workflow.createWorktree(gitInput, options), result);
        assert.deepEqual(yield* workflow.createWorktree(jjInput, options), result);
        expect(gitCreateWorktree).toHaveBeenCalledExactlyOnceWith(gitInput, options);
        expect(jjCreateWorktree).toHaveBeenCalledExactlyOnceWith(jjInput, options);
      }).pipe(
        Effect.provide(
          makeLayer({
            detect: ({ cwd }) => Effect.succeed(handleFor(cwd === "/jj-repo" ? "jj" : "git")),
            gitManager: { createWorktree: gitCreateWorktree },
            jj: { createWorktree: jjCreateWorktree },
          }),
        ),
      );
    },
  );

  it.effect("routes exact ref-name lookups to Jujutsu without treating names as revisions", () => {
    const hasRefNamed = vi.fn(() => Effect.succeed(false));

    return Effect.gen(function* () {
      const workflow = yield* GitWorkflowService.GitWorkflowService;
      assert.equal(yield* workflow.hasRefNamed({ cwd: "/jj-repo", refName: "root()" }), false);
      assert.equal(yield* workflow.hasRefNamed({ cwd: "/jj-repo", refName: "topic/*" }), false);
      expect(hasRefNamed).toHaveBeenCalledExactlyOnceWith({
        cwd: "/jj-repo",
        refName: "root()",
      });
    }).pipe(
      Effect.provide(
        makeLayer({
          detect: () => Effect.succeed(handleFor("jj")),
          jj: { hasRefNamed },
        }),
      ),
    );
  });

  it.effect("preserves exact-name renames in both workflow lanes", () => {
    const gitRename = vi.fn(() => Effect.succeed({ branch: "renamed" }));
    const jjRename = vi.fn(() => Effect.succeed({ branch: "renamed" }));
    const gitInput = {
      cwd: "/git-repo",
      oldBranch: "topic",
      newBranch: "renamed",
      exactName: true,
    };
    const jjInput = { ...gitInput, cwd: "/jj-repo" };

    return Effect.gen(function* () {
      const workflow = yield* GitWorkflowService.GitWorkflowService;
      assert.deepEqual(yield* workflow.renameBranch(gitInput), { branch: "renamed" });
      assert.deepEqual(yield* workflow.renameBranch(jjInput), { branch: "renamed" });
      expect(gitRename).toHaveBeenCalledExactlyOnceWith(gitInput);
      expect(jjRename).toHaveBeenCalledExactlyOnceWith(jjInput);
    }).pipe(
      Effect.provide(
        makeLayer({
          detect: ({ cwd }) => Effect.succeed(handleFor(cwd === "/jj-repo" ? "jj" : "git")),
          git: { renameBranch: gitRename },
          jj: { renameBranch: jjRename },
        }),
      ),
    );
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
        makeLayer({
          detect: () => Effect.succeed(null),
        }),
      ),
    ),
  );

  it.effect("fails the status poll when detection itself fails, keeping the cause", () => {
    const cause = new VcsRepositoryDetectionError({
      operation: "VcsDriverRegistry.detect",
      cwd: "/repo",
      detail: "the reason a healthy project could not be classified",
    });

    return Effect.gen(function* () {
      const workflow = yield* GitWorkflowService.GitWorkflowService;
      const error = yield* workflow.status({ cwd: "/repo" }).pipe(Effect.flip);

      // Reporting `isRepo: false` here renders a blank branch toolbar for a working repository
      // and drops the only record of why detection failed.
      expect(error).toMatchObject({
        _tag: "GitManagerError",
        operation: "GitWorkflowService.status",
        cwd: "/repo",
        detail: "Failed to detect a VCS repository for this Git workflow.",
        cause,
      });
      expect(error.message).not.toContain(cause.detail);
    }).pipe(
      Effect.provide(
        makeLayer({
          detect: () => Effect.fail(cause),
        }),
      ),
    );
  });

  it.effect("preserves the Git resolution error and cause when no repository is detected", () => {
    const cause = new VcsUnsupportedOperationError({
      operation: "VcsDriverRegistry.resolve",
      kind: "unknown",
      detail: "No supported VCS repository was detected at /repo.",
    });
    return Effect.gen(function* () {
      const workflow = yield* GitWorkflowService.GitWorkflowService;
      const error = yield* workflow.createRef({ cwd: "/repo", refName: "feat" }).pipe(Effect.flip);

      expect(error).toMatchObject({
        _tag: "GitCommandError",
        operation: "GitWorkflowService.createRef",
        command: "vcs-route",
        cwd: "/repo",
        cause,
      });
      expect(error.detail).toBe("Failed to resolve the VCS driver for this Git command.");
      const workflowError = yield* workflow
        .runStackedAction({ cwd: "/repo", actionId: "test", action: "commit" })
        .pipe(Effect.flip);
      expect(workflowError).toMatchObject({
        _tag: "GitManagerError",
        operation: "GitWorkflowService.runStackedAction",
        cwd: "/repo",
        detail: "Failed to resolve the VCS driver for this Git workflow.",
        cause,
      });
    }).pipe(
      Effect.provide(
        makeLayer({
          detect: () => Effect.succeed(null),
        }),
      ),
    );
  });

  it.effect(
    "separates an undetectable directory from a missing one, without leaking the cause",
    () => {
      const cause = new VcsRepositoryDetectionError({
        operation: "VcsDriverRegistry.detect",
        cwd: "/repo",
        detail: "upstream command detail must stay in the cause chain",
      });

      return Effect.gen(function* () {
        const workflow = yield* GitWorkflowService.GitWorkflowService;
        const error = yield* workflow
          .createRef({ cwd: "/repo", refName: "feat" })
          .pipe(Effect.flip);

        expect(error).toMatchObject({
          _tag: "GitCommandError",
          operation: "GitWorkflowService.createRef",
          command: "vcs-route",
          cwd: "/repo",
          cause,
        });
        expect(error.detail).toBe("Failed to resolve the VCS driver for this Git command.");
        expect(error.message).not.toContain(cause.detail);
      }).pipe(
        Effect.provide(
          makeLayer({
            detect: () => Effect.fail(cause),
          }),
        ),
      );
    },
  );

  it.effect("routes a Git cwd to the Git lane and a Jujutsu cwd to JjWorkflow", () => {
    const gitListRefs = vi.fn(() =>
      Effect.succeed({
        refs: [],
        isRepo: true,
        hasPrimaryRemote: false,
        nextCursor: null,
        totalCount: 0,
      }),
    );
    const jjListRefs = vi.fn(() =>
      Effect.succeed({
        refs: [],
        isRepo: true,
        hasPrimaryRemote: false,
        nextCursor: null,
        totalCount: 0,
      }),
    );

    return Effect.gen(function* () {
      const workflow = yield* GitWorkflowService.GitWorkflowService;
      yield* workflow.listRefs({ cwd: "/git-repo" });
      yield* workflow.listRefs({ cwd: "/jj-repo" });

      assert.equal(gitListRefs.mock.calls.length, 1);
      assert.equal(jjListRefs.mock.calls.length, 1);
    }).pipe(
      Effect.provide(
        makeLayer({
          detect: ({ cwd }) => Effect.succeed(handleFor(cwd === "/jj-repo" ? "jj" : "git")),
          git: { listRefs: gitListRefs },
          jj: { listRefs: jjListRefs },
        }),
      ),
    );
  });

  for (const method of [
    "invalidateLocalStatus",
    "invalidateRemoteStatus",
    "invalidateStatus",
  ] as const) {
    for (const kind of ["git", "jj", null] as const) {
      it.effect(
        `routes ${method} to ${kind === "jj" ? "jj" : "git"} for ${kind ?? "no repository"}`,
        () => {
          const gitInvalidate = vi.fn(() => Effect.void);
          const jjInvalidate = vi.fn(() => Effect.void);

          return Effect.gen(function* () {
            const workflow = yield* GitWorkflowService.GitWorkflowService;
            yield* workflow[method]("/repo");
            yield* workflow[method]("/repo");

            assert.equal(gitInvalidate.mock.calls.length, kind === "jj" ? 0 : 2);
            assert.equal(jjInvalidate.mock.calls.length, kind === "jj" ? 2 : 0);
          }).pipe(
            Effect.provide(
              makeLayer({
                detect: () => Effect.succeed(kind === null ? null : handleFor(kind)),
                gitManager: { [method]: gitInvalidate },
                jj: { [method]: jjInvalidate },
              }),
            ),
          );
        },
      );
    }
    it.effect(`keeps ${method} infallible when repository detection fails`, () => {
      const gitInvalidate = vi.fn(() => Effect.void);
      const jjInvalidate = vi.fn(() => Effect.void);

      return Effect.gen(function* () {
        const workflow = yield* GitWorkflowService.GitWorkflowService;
        yield* workflow[method]("/repo");
        assert.equal(gitInvalidate.mock.calls.length, 1);
        assert.equal(jjInvalidate.mock.calls.length, 0);
      }).pipe(
        Effect.provide(
          makeLayer({
            detect: () =>
              Effect.fail(
                new VcsRepositoryDetectionError({
                  operation: "VcsDriverRegistry.detect",
                  cwd: "/repo",
                  detail: "Repository markers could not be read.",
                }),
              ),
            gitManager: { [method]: gitInvalidate },
            jj: { [method]: jjInvalidate },
          }),
        ),
      );
    });
  }

  it.effect("refuses workspace removal when the project is not a repository", () =>
    Effect.gen(function* () {
      const workflow = yield* GitWorkflowService.GitWorkflowService;
      const failure = yield* workflow
        .removeWorktree({ cwd: "/missing", path: "/worktree" })
        .pipe(Effect.flip);
      assert.equal(failure.command, "vcs-route");
      assert.instanceOf(failure.cause, VcsUnsupportedOperationError);
      assert.match(failure.cause.detail, /No supported VCS repository/);
    }).pipe(Effect.provide(makeLayer({ detect: () => Effect.succeed(null) }))),
  );

  it.effect("removes a pre-flip Git worktree inside a Jujutsu project through the Git lane", () => {
    const gitRemoveWorktree = vi.fn(() => Effect.void);
    const jjRemoveWorktree = vi.fn(() => Effect.void);

    return Effect.gen(function* () {
      const workflow = yield* GitWorkflowService.GitWorkflowService;
      yield* workflow.removeWorktree({ cwd: "/jj-project", path: "/worktrees/pre-flip" });

      assert.equal(gitRemoveWorktree.mock.calls.length, 1);
      assert.equal(jjRemoveWorktree.mock.calls.length, 0);
    }).pipe(
      Effect.provide(
        makeLayer({
          detect: ({ cwd }) =>
            Effect.succeed(handleFor(cwd === "/worktrees/pre-flip" ? "git" : "jj")),
          git: { removeWorktree: gitRemoveWorktree },
          jj: { removeWorktree: jjRemoveWorktree },
        }),
      ),
    );
  });

  it.effect("falls back to the project's kind when the workspace path is gone", () => {
    const jjRemoveWorktree = vi.fn(() => Effect.void);

    return Effect.gen(function* () {
      const workflow = yield* GitWorkflowService.GitWorkflowService;
      yield* workflow.removeWorktree({ cwd: "/jj-project", path: "/worktrees/vanished" });

      assert.equal(jjRemoveWorktree.mock.calls.length, 1);
    }).pipe(
      Effect.provide(
        makeLayer({
          detect: ({ cwd }) => Effect.succeed(cwd === "/jj-project" ? handleFor("jj") : null),
          jj: { removeWorktree: jjRemoveWorktree },
        }),
      ),
    );
  });

  it.effect("finds a name among the refs of every namespace", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const cwd = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-ref-named-" });
      const workflow = yield* GitWorkflowService.GitWorkflowService;
      const driver = yield* GitVcsDriver.GitVcsDriver;
      for (const args of [
        ["init", "-b", "main"],
        ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "--allow-empty", "-m", "init"],
        ["update-ref", "refs/remotes/upstream/feature/topic", "HEAD"],
        ["symbolic-ref", "refs/remotes/origin/alias", "refs/heads/main"],
        ["update-ref", "refs/mirror/origin/mirrored", "HEAD"],
      ]) {
        yield* driver.execute({ operation: "test.setupRepo", cwd, args });
      }
      const found = yield* Effect.forEach(
        ["main", "feature/topic", "alias", "mirrored", "t3/renamed", "feature/*"],
        (refName) => workflow.hasRefNamed({ cwd, refName }),
      );
      assert.deepEqual(found, [true, true, true, true, false, false]);
    }).pipe(
      Effect.scoped,
      Effect.provide(
        GitWorkflowService.layer.pipe(
          Layer.provide(
            Layer.mock(VcsDriverRegistry.VcsDriverRegistry)({
              detect: () => Effect.succeed(handleFor("git")),
            }),
          ),
          Layer.provide(Layer.mock(GitManager.GitManager)({})),
          Layer.provide(Layer.mock(JjWorkflow.JjWorkflow)({})),
          Layer.provide(Layer.mock(JjVcsDriver.JjVcsDriver)({ capabilities: jjCapabilities })),
          Layer.provideMerge(GitVcsDriver.layer),
          Layer.provideMerge(VcsProcess.layer),
          Layer.provideMerge(
            ServerConfig.layerTest(process.cwd(), { prefix: "t3-ref-named-" }).pipe(
              Layer.provide(NodeServices.layer),
            ),
          ),
          Layer.provideMerge(NodeServices.layer),
        ),
      ),
    ),
  );
});

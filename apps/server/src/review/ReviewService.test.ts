import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import {
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  GitCommandError,
  type OrchestrationProjectShell,
  type OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import * as Option from "effect/Option";

import * as ServerConfig from "../config.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as KnownWorkspaces from "../workspace/KnownWorkspaces.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import * as ReviewService from "./ReviewService.ts";

function layer(input: {
  readonly workspaceRoot: string;
  readonly baseDir: string;
  readonly detectCalls?: Array<{ readonly cwd: string }>;
  readonly worktreesDirectory?: string;
  readonly previousWorktreesDirectories?: ReadonlyArray<string>;
  readonly projectRoots?: ReadonlyArray<string> | "unavailable";
  readonly threadWorktrees?: ReadonlyArray<{ worktreePath: string; deleted?: boolean }>;
  /** What `git worktree list` reports for every project. */
  readonly gitWorktrees?: ReadonlyArray<string>;
  readonly threadCwd?: string;
  readonly projectModel?: string;
  readonly generationCalls?: Array<{ model: string; shas: ReadonlyArray<string> }>;
  readonly generate?: TextGeneration.TextGeneration["Service"]["generateCommitDescriptions"];
  readonly gitCalls?: Array<{ operation: "resolve" | "context"; shas: ReadonlyArray<string> }>;
  readonly readContext?: GitVcsDriver.GitVcsDriver["Service"]["getReviewCommitDescriptionContext"];
}) {
  const projectRoots = input.projectRoots ?? [];
  return ReviewService.layer.pipe(
    Layer.provide(KnownWorkspaces.layer),
    Layer.provide(
      Layer.effectDiscard(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          for (const [index, thread] of (input.threadWorktrees ?? []).entries()) {
            yield* sql`
              INSERT INTO orchestration_v2_projection_threads (
                thread_id, project_id, title, default_provider, runtime_mode, interaction_mode,
                created_at, updated_at, deleted_at, payload_json
              ) VALUES (
                ${`thread-${index}`}, 'project-0', 'Thread', 'codex', 'full-access', 'default',
                '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z',
                ${thread.deleted ? "2026-01-02T00:00:00.000Z" : null},
                ${JSON.stringify({ worktreePath: thread.worktreePath })}
              )
            `;
          }
        }),
      ).pipe(Layer.provideMerge(SqlitePersistence.layerMemory)),
    ),
    Layer.provide(
      Layer.mock(ProjectStore.ProjectStoreV2)({
        getShell: () =>
          Effect.succeed(
            Option.some({
              id: ProjectId.make("project-0"),
              workspaceRoot: input.workspaceRoot,
            } as OrchestrationProjectShell),
          ),
        listShells: () =>
          projectRoots === "unavailable"
            ? Effect.fail(
                new ProjectStore.ProjectStoreV2Error({ operation: "list", cause: "offline" }),
              )
            : Effect.succeed(
                projectRoots.map((workspaceRoot, index) => ({
                  id: ProjectId.make(`project-${index}`),
                  title: `Project ${index}`,
                  workspaceRoot,
                  defaultModelSelection: null,
                  scripts: [],
                  createdAt: "2026-01-01T00:00:00.000Z",
                  updatedAt: "2026-01-01T00:00:00.000Z",
                })),
              ),
      }),
    ),
    Layer.provide(
      Layer.mock(ProjectionStore.ProjectionStoreV2)({
        getThreadShell: () =>
          Effect.succeed(
            input.threadCwd
              ? ({
                  projectId: ProjectId.make("project-0"),
                  worktreePath: input.threadCwd,
                } as OrchestrationV2ThreadShell)
              : null,
          ),
      }),
    ),
    Layer.provide(
      Layer.mock(TextGeneration.TextGeneration)({
        generateCommitDescriptions:
          input.generate ??
          ((request) =>
            Effect.sync(() => {
              input.generationCalls?.push({
                model: request.modelSelection.model,
                shas: request.commits.map((commit) => commit.sha),
              });
              return {
                descriptions: request.commits.map((commit) => ({
                  sha: commit.sha,
                  description: `${request.modelSelection.model}: ${commit.subject}`,
                })),
              };
            })),
      }),
    ),
    Layer.provide(
      Layer.mock(VcsDriverRegistry.VcsDriverRegistry)({
        get: () => Effect.die("unexpected VCS registry get"),
        resolve: () => Effect.die("unexpected VCS registry resolve"),
        detect: (request) =>
          Effect.sync(() => {
            input.detectCalls?.push({ cwd: request.cwd });
            return null;
          }),
      }),
    ),
    Layer.provide(
      Layer.mock(GitVcsDriver.GitVcsDriver)({
        listWorktreePaths: () => Effect.succeed([...(input.gitWorktrees ?? [])]),
        resolveReviewCommits: (request) =>
          Effect.sync(() => {
            input.gitCalls?.push({ operation: "resolve", shas: request.shas });
            return {
              cwd: input.workspaceRoot,
              repositoryKey: `${input.workspaceRoot}/.git`,
              commits: request.shas.map((sha) => ({ sha, parent: "0".repeat(40) })),
            };
          }),
        getReviewCommitDescriptionContext: (request) =>
          Effect.suspend(() => {
            input.gitCalls?.push({ operation: "context", shas: request.shas });
            return input.readContext
              ? input.readContext(request)
              : Effect.succeed({
                  repositoryKey: `${input.workspaceRoot}/.git`,
                  commits: request.shas.map((sha) => ({
                    sha,
                    subject: "change",
                    body: "",
                    files: [],
                    patch: "",
                  })),
                });
          }),
      }),
    ),
    Layer.provideMerge(
      ServerSettings.ServerSettingsService.layerTest({
        worktreesDirectory: input.worktreesDirectory ?? "",
        previousWorktreesDirectories: [...(input.previousWorktreesDirectories ?? [])],
        ...(input.projectModel
          ? {
              projectSettingsOverrides: {
                [ProjectId.make("project-0")]: {
                  textGenerationModelSelection: {
                    instanceId: ProviderInstanceId.make("codex"),
                    model: input.projectModel,
                  },
                },
              },
            }
          : {}),
      }),
    ),
    Layer.provide(ServerConfig.layerTest(input.workspaceRoot, input.baseDir)),
    Layer.provideMerge(NodeServices.layer),
  );
}

describe("ReviewService", () => {
  it.effect("revalidates cached commits and reads full context only for cache misses", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const workspaceRoot = yield* fs.makeTempDirectoryScoped();
      const baseDir = yield* fs.makeTempDirectoryScoped();
      const gitCalls: Array<{ operation: "resolve" | "context"; shas: ReadonlyArray<string> }> = [];
      yield* Effect.gen(function* () {
        const review = yield* ReviewService.ReviewService;
        const request = {
          cwd: workspaceRoot,
          threadId: ThreadId.make("thread-0"),
          shas: ["a".repeat(40), "b".repeat(40)],
        };
        const first = yield* review.generateCommitDescriptions(request);
        assert.deepStrictEqual(yield* review.generateCommitDescriptions(request), first);
        yield* review.generateCommitDescriptions({
          ...request,
          shas: ["a".repeat(40), "c".repeat(40)],
        });
        assert.deepStrictEqual(gitCalls, [
          { operation: "resolve", shas: request.shas },
          { operation: "context", shas: request.shas },
          { operation: "resolve", shas: request.shas },
          { operation: "resolve", shas: ["a".repeat(40), "c".repeat(40)] },
          { operation: "context", shas: ["c".repeat(40)] },
        ]);
      }).pipe(
        Effect.provide(layer({ workspaceRoot, baseDir, threadCwd: workspaceRoot, gitCalls })),
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("clears claimed misses after context read failure or cancellation", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const workspaceRoot = yield* fs.makeTempDirectoryScoped();
      const baseDir = yield* fs.makeTempDirectoryScoped();
      const started = yield* Deferred.make<void>();
      let reads = 0;
      yield* Effect.gen(function* () {
        const review = yield* ReviewService.ReviewService;
        const request = {
          cwd: workspaceRoot,
          threadId: ThreadId.make("thread-0"),
          shas: ["a".repeat(40)],
        };
        const error = yield* review.generateCommitDescriptions(request).pipe(Effect.flip);
        assert.strictEqual(error._tag, "GitCommandError");
        const cancelled = yield* review.generateCommitDescriptions(request).pipe(Effect.forkChild);
        yield* Deferred.await(started);
        yield* Fiber.interrupt(cancelled);
        const result = yield* review.generateCommitDescriptions(request);
        assert.strictEqual(result.descriptions.length, 1);
        yield* review.generateCommitDescriptions(request);
        assert.strictEqual(reads, 3);
      }).pipe(
        Effect.provide(
          layer({
            workspaceRoot,
            baseDir,
            threadCwd: workspaceRoot,
            readContext: (request) =>
              Effect.gen(function* () {
                reads++;
                if (reads === 1)
                  return yield* new GitCommandError({
                    operation: "readContext",
                    cwd: workspaceRoot,
                    command: "git diff",
                    detail: "Context unavailable.",
                  });
                if (reads === 2) {
                  yield* Deferred.succeed(started, undefined);
                  return yield* Effect.never;
                }
                return {
                  repositoryKey: `${workspaceRoot}/.git`,
                  commits: request.shas.map((sha) => ({
                    sha,
                    subject: "change",
                    body: "",
                    files: [],
                    patch: "",
                  })),
                };
              }),
          }),
        ),
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("rejects invalid batches before invoking the model", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const workspaceRoot = yield* fs.makeTempDirectoryScoped();
      const baseDir = yield* fs.makeTempDirectoryScoped();
      const calls: Array<{ model: string; shas: ReadonlyArray<string> }> = [];
      yield* Effect.gen(function* () {
        const review = yield* ReviewService.ReviewService;
        for (const shas of [[], ["HEAD"], Array(11).fill("a".repeat(40))]) {
          const error = yield* review
            .generateCommitDescriptions({
              cwd: workspaceRoot,
              threadId: ThreadId.make("thread-0"),
              shas,
            })
            .pipe(Effect.flip);
          assert.strictEqual(error._tag, "TextGenerationError");
        }
        assert.deepStrictEqual(calls, []);
      }).pipe(
        Effect.provide(
          layer({ workspaceRoot, baseDir, threadCwd: workspaceRoot, generationCalls: calls }),
        ),
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "deduplicates batches, limits summaries to 80 characters, and retries failed output",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const workspaceRoot = yield* fs.makeTempDirectoryScoped();
        const baseDir = yield* fs.makeTempDirectoryScoped();
        const calls: Array<ReadonlyArray<string>> = [];
        yield* Effect.gen(function* () {
          const review = yield* ReviewService.ReviewService;
          const request = {
            cwd: workspaceRoot,
            threadId: ThreadId.make("thread-0"),
            shas: ["a".repeat(40), "b".repeat(40), "a".repeat(40)],
          };
          const error = yield* review.generateCommitDescriptions(request).pipe(Effect.flip);
          assert.strictEqual(error._tag, "TextGenerationError");
          const result = yield* review.generateCommitDescriptions(request);
          assert.deepStrictEqual(
            result.descriptions,
            ["a", "b"].map((letter) => ({ sha: letter.repeat(40), description: "x".repeat(80) })),
          );
          yield* review.generateCommitDescriptions({
            ...request,
            shas: ["a".repeat(40), "c".repeat(40)],
          });
          assert.deepStrictEqual(calls, [
            ["a".repeat(40), "b".repeat(40)],
            ["a".repeat(40), "b".repeat(40)],
            ["c".repeat(40)],
          ]);
        }).pipe(
          Effect.provide(
            layer({
              workspaceRoot,
              baseDir,
              threadCwd: workspaceRoot,
              generate: (request) =>
                Effect.sync(() => {
                  calls.push(request.commits.map((commit) => commit.sha));
                  return {
                    descriptions:
                      calls.length === 1
                        ? []
                        : request.commits.map((commit) => ({
                            sha: commit.sha,
                            description: `  ${"x".repeat(100)}\n  `,
                          })),
                  };
                }),
            }),
          ),
        );
      }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("coalesces concurrent requests and permits retry after cancellation", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const workspaceRoot = yield* fs.makeTempDirectoryScoped();
      const baseDir = yield* fs.makeTempDirectoryScoped();
      const started = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const cancelStarted = yield* Deferred.make<void>();
      let calls = 0;
      yield* Effect.gen(function* () {
        const review = yield* ReviewService.ReviewService;
        const request = {
          cwd: workspaceRoot,
          threadId: ThreadId.make("thread-0"),
          shas: ["a".repeat(40)],
        };
        const first = yield* review.generateCommitDescriptions(request).pipe(Effect.forkChild);
        yield* Deferred.await(started);
        const second = yield* review
          .generateCommitDescriptions(request)
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* Deferred.succeed(release, undefined);
        assert.deepStrictEqual(yield* Fiber.join(first), yield* Fiber.join(second));
        assert.strictEqual(calls, 1);
        const next = { ...request, shas: ["b".repeat(40)] };
        const cancelled = yield* review
          .generateCommitDescriptions(next)
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* Deferred.await(cancelStarted);
        yield* Fiber.interrupt(cancelled);
        const retried = yield* review.generateCommitDescriptions(next);
        assert.deepStrictEqual(retried.descriptions, [
          { sha: "b".repeat(40), description: "summary" },
        ]);
        assert.strictEqual(calls, 3);
      }).pipe(
        Effect.provide(
          layer({
            workspaceRoot,
            baseDir,
            threadCwd: workspaceRoot,
            generate: (request) =>
              Effect.gen(function* () {
                calls++;
                if (calls === 1) {
                  yield* Deferred.succeed(started, undefined);
                  yield* Deferred.await(release);
                }
                if (calls === 2) {
                  yield* Deferred.succeed(cancelStarted, undefined);
                  return yield* Effect.never;
                }
                return {
                  descriptions: request.commits.map((commit) => ({
                    sha: commit.sha,
                    description: "summary",
                  })),
                };
              }),
          }),
        ),
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("uses the project text model and caches each commit per model", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const workspaceRoot = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-model-" });
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-base-" });
      const calls: Array<{ model: string; shas: ReadonlyArray<string> }> = [];
      yield* Effect.gen(function* () {
        const review = yield* ReviewService.ReviewService;
        const settings = yield* ServerSettings.ServerSettingsService;
        const request = {
          cwd: workspaceRoot,
          threadId: ThreadId.make("thread-0"),
          shas: ["a".repeat(40)],
        };
        const first = yield* review.generateCommitDescriptions(request);
        const repeated = yield* review.generateCommitDescriptions(request);
        assert.strictEqual(first.modelSelection.model, "gpt-5.6-luna");
        assert.deepStrictEqual(repeated.descriptions, first.descriptions);
        assert.strictEqual(calls.length, 1);

        yield* settings.updateSettings({
          projectSettingsOverrides: {
            [ProjectId.make("project-0")]: {
              textGenerationModelSelection: {
                instanceId: ProviderInstanceId.make("codex"),
                model: "gpt-5.6-sol",
              },
            },
          },
        });
        const changed = yield* review.generateCommitDescriptions(request);
        assert.strictEqual(changed.modelSelection.model, "gpt-5.6-sol");
        assert.deepStrictEqual(
          calls.map((call) => call.model),
          ["gpt-5.6-luna", "gpt-5.6-sol"],
        );
        yield* settings.updateSettings({
          projectSettingsOverrides: {
            [ProjectId.make("project-0")]: {
              textGenerationModelSelection: {
                instanceId: ProviderInstanceId.make("codex"),
                model: "gpt-5.6-sol",
                options: [{ id: "reasoningEffort", value: "high" }],
              },
            },
          },
        });
        yield* review.generateCommitDescriptions(request);
        assert.strictEqual(calls.length, 3);
      }).pipe(
        Effect.provide(
          layer({
            workspaceRoot,
            baseDir,
            threadCwd: workspaceRoot,
            projectModel: "gpt-5.6-luna",
            generationCalls: calls,
          }),
        ),
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("rejects a workspace that does not belong to the review thread", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const workspaceRoot = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-model-" });
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-base-" });
      const otherCwd = `${workspaceRoot}/other`;
      yield* fs.makeDirectory(otherCwd);
      const calls: Array<{ model: string; shas: ReadonlyArray<string> }> = [];
      const error = yield* Effect.gen(function* () {
        const review = yield* ReviewService.ReviewService;
        return yield* review
          .generateCommitDescriptions({
            cwd: otherCwd,
            threadId: ThreadId.make("thread-0"),
            shas: ["a".repeat(40)],
          })
          .pipe(Effect.flip);
      }).pipe(
        Effect.provide(
          layer({ workspaceRoot, baseDir, threadCwd: workspaceRoot, generationCalls: calls }),
        ),
      );
      assert.strictEqual(error._tag, "VcsRepositoryDetectionError");
      assert.deepStrictEqual(calls, []);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("rejects diff preview cwd outside the configured workspace roots", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const workspaceRoot = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-workspace-" });
      const outsideRoot = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-outside-" });
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-base-" });
      const detectCalls: Array<{ readonly cwd: string }> = [];

      const error = yield* Effect.gen(function* () {
        const review = yield* ReviewService.ReviewService;
        return yield* review.getDiffPreview({ cwd: outsideRoot }).pipe(Effect.flip);
      }).pipe(Effect.provide(layer({ workspaceRoot, baseDir, detectCalls })));

      assert.strictEqual(error._tag, "VcsRepositoryDetectionError");
      assert.strictEqual(error.operation, "ReviewService.getDiffPreview");
      assert.match(
        "detail" in error ? error.detail : "",
        /must stay within the configured workspace root/,
      );
      assert.deepStrictEqual(detectCalls, []);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("rejects commit list cwd outside the configured workspace roots", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const workspaceRoot = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-workspace-" });
      const outsideRoot = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-outside-" });
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-base-" });
      const detectCalls: Array<{ readonly cwd: string }> = [];

      const error = yield* Effect.gen(function* () {
        const review = yield* ReviewService.ReviewService;
        return yield* review.getBranchCommits({ cwd: outsideRoot }).pipe(Effect.flip);
      }).pipe(Effect.provide(layer({ workspaceRoot, baseDir, detectCalls })));

      assert.strictEqual(error._tag, "VcsRepositoryDetectionError");
      assert.strictEqual(error.operation, "ReviewService.getBranchCommits");
      assert.deepStrictEqual(detectCalls, []);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("allows previous custom worktree locations but never a filesystem root", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const workspaceRoot = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-workspace-" });
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-base-" });
      const previous = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-old-worktrees-" });
      const outsideRoot = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-outside-" });

      const result = yield* Effect.gen(function* () {
        const review = yield* ReviewService.ReviewService;
        return yield* review.getDiffPreview({ cwd: previous });
      }).pipe(
        Effect.provide(
          layer({
            workspaceRoot,
            baseDir,
            worktreesDirectory: "/",
            previousWorktreesDirectories: [previous],
          }),
        ),
      );
      assert.strictEqual(result.cwd, previous);

      const rootLink = `${baseDir}/root-link`;
      yield* fs.symlink("/", rootLink);
      for (const worktreesDirectory of ["/", rootLink]) {
        const error = yield* Effect.gen(function* () {
          const review = yield* ReviewService.ReviewService;
          return yield* review.getDiffPreview({ cwd: outsideRoot }).pipe(Effect.flip);
        }).pipe(Effect.provide(layer({ workspaceRoot, baseDir, worktreesDirectory })));
        assert.strictEqual(error._tag, "VcsRepositoryDetectionError");
      }
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("allows registered project roots outside the server cwd", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const workspaceRoot = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-workspace-" });
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-base-" });
      const projectRoot = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-project-" });
      const projectChild = `${projectRoot}/packages/app`;
      yield* fs.makeDirectory(projectChild, { recursive: true });
      const sibling = `${projectRoot}-sibling`;
      yield* fs.makeDirectory(sibling);
      yield* Effect.addFinalizer(() => fs.remove(sibling, { recursive: true }).pipe(Effect.ignore));

      const review = (cwd: string, projectRoots: ReadonlyArray<string> | "unavailable") =>
        Effect.gen(function* () {
          const service = yield* ReviewService.ReviewService;
          return yield* service.getDiffPreview({ cwd });
        }).pipe(Effect.provide(layer({ workspaceRoot, baseDir, projectRoots })));

      assert.strictEqual((yield* review(projectRoot, [projectRoot])).cwd, projectRoot);
      assert.strictEqual((yield* review(projectChild, [projectRoot])).cwd, projectChild);
      // A child whose name starts with `..` is still inside.
      const dottedChild = `${projectRoot}/..feature`;
      yield* fs.makeDirectory(dottedChild);
      assert.strictEqual((yield* review(dottedChild, [projectRoot])).cwd, dottedChild);
      for (const [cwd, projectRoots] of [
        [sibling, [projectRoot]],
        [projectRoot, []],
        [projectRoot, "unavailable"],
      ] as const) {
        const error = yield* review(cwd, projectRoots).pipe(Effect.flip);
        assert.strictEqual(error._tag, "VcsRepositoryDetectionError");
      }
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("allows the worktree a thread is bound to, and nothing else outside the project", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const workspaceRoot = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-workspace-" });
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-base-" });
      const project = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-project-" });
      // Checkouts outside every managed folder, as `git worktree add ../feature` makes.
      const bound = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-bound-" });
      const deleted = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-deleted-" });
      const unbound = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-unbound-" });
      // A client can set a thread's path to any folder; git doesn't list this one.
      const claimed = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-claimed-" });
      yield* fs.makeDirectory(`${bound}/sub`);

      const review = (cwd: string) =>
        Effect.gen(function* () {
          const service = yield* ReviewService.ReviewService;
          return yield* service.getDiffPreview({ cwd });
        }).pipe(
          Effect.provide(
            layer({
              workspaceRoot,
              baseDir,
              projectRoots: [project],
              gitWorktrees: [project, bound, deleted],
              threadWorktrees: [
                { worktreePath: bound },
                { worktreePath: claimed },
                { worktreePath: deleted, deleted: true },
                // A relative path would resolve against the server's own cwd.
                { worktreePath: "t3-review-relative" },
                // A filesystem root would make every folder look bound.
                { worktreePath: "/" },
              ],
            }),
          ),
        );

      for (const cwd of [bound, `${bound}/sub`]) {
        assert.strictEqual((yield* review(cwd)).cwd, cwd);
      }
      for (const cwd of [deleted, unbound, claimed, `${process.cwd()}/t3-review-relative`]) {
        const error = yield* review(cwd).pipe(Effect.flip);
        assert.strictEqual(error._tag, "VcsRepositoryDetectionError");
      }
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("allows a thread's worktree linked from a managed folder to a checkout elsewhere", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const workspaceRoot = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-workspace-" });
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-base-" });
      const managed = yield* fs.realPath(
        yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-worktrees-" }),
      );
      const checkout = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-checkout-" });
      yield* fs.symlink(checkout, `${managed}/feature`);

      const result = yield* Effect.gen(function* () {
        const review = yield* ReviewService.ReviewService;
        return yield* review.getDiffPreview({ cwd: checkout });
      }).pipe(
        Effect.provide(
          layer({
            workspaceRoot,
            baseDir,
            worktreesDirectory: managed,
            threadWorktrees: [{ worktreePath: `${managed}/feature` }],
          }),
        ),
      );
      assert.strictEqual(result.cwd, checkout);
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});

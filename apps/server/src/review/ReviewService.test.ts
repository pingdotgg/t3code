import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PlatformError from "effect/PlatformError";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/unstable/process";
import { type OrchestrationProject, ProjectId } from "@t3tools/contracts";

import { ServerConfig } from "../config.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as VcsDriver from "../vcs/VcsDriver.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as ReviewService from "./ReviewService.ts";
import * as ReviewWatcher from "./ReviewWatcher.ts";

function makeLayer(input: {
  readonly workspaceRoot: string;
  readonly baseDir: string;
  readonly detectCalls?: Array<{ readonly cwd: string }>;
  readonly registeredProject?: OrchestrationProject;
}) {
  return ReviewService.layer.pipe(
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
    Layer.provide(Layer.mock(GitVcsDriver.GitVcsDriver)({})),
    Layer.provide(
      Layer.mock(ProjectionSnapshotQuery)({
        getActiveProjectByWorkspaceRoot: (workspaceRoot) =>
          Effect.succeed(
            workspaceRoot === input.registeredProject?.workspaceRoot
              ? Option.some(input.registeredProject)
              : Option.none(),
          ),
      }),
    ),
    Layer.provide(ServerConfig.layerTest(input.workspaceRoot, input.baseDir)),
    Layer.provide(Layer.succeed(ReviewWatcher.ReviewWatcher, { watch: () => Stream.never })),
    Layer.provideMerge(NodeServices.layer),
  );
}

describe("ReviewService", () => {
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
      }).pipe(Effect.provide(makeLayer({ workspaceRoot, baseDir, detectCalls })));

      assert.strictEqual(error._tag, "VcsRepositoryDetectionError");
      assert.strictEqual(error.operation, "ReviewService.getDiffPreview");
      assert.match(
        "detail" in error ? error.detail : "",
        /must stay within a configured or registered workspace root/,
      );
      assert.deepStrictEqual(detectCalls, []);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("allows diff preview cwd for an active registered project", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const workspaceRoot = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-workspace-" });
      const projectRoot = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-project-" });
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-base-" });
      const detectCalls: Array<{ readonly cwd: string }> = [];
      const registeredProject: OrchestrationProject = {
        id: ProjectId.make("registered-project"),
        title: "Registered project",
        workspaceRoot: projectRoot,
        defaultModelSelection: null,
        scripts: [],
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        deletedAt: null,
      };

      const result = yield* Effect.gen(function* () {
        const review = yield* ReviewService.ReviewService;
        return yield* review.getDiffPreview({ cwd: projectRoot });
      }).pipe(
        Effect.provide(makeLayer({ workspaceRoot, baseDir, detectCalls, registeredProject })),
      );

      assert.strictEqual(result.cwd, projectRoot);
      assert.deepStrictEqual(result.sources, []);
      assert.deepStrictEqual(detectCalls, [{ cwd: projectRoot }]);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("allows diff preview cwd inside the configured workspace root", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const workspaceRoot = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-workspace-" });
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-base-" });
      const detectCalls: Array<{ readonly cwd: string }> = [];

      const result = yield* Effect.gen(function* () {
        const review = yield* ReviewService.ReviewService;
        return yield* review.getDiffPreview({ cwd: workspaceRoot });
      }).pipe(Effect.provide(makeLayer({ workspaceRoot, baseDir, detectCalls })));

      assert.strictEqual(result.cwd, workspaceRoot);
      assert.deepStrictEqual(result.sources, []);
      assert.deepStrictEqual(detectCalls, [{ cwd: workspaceRoot }]);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("streams an initial branch preview before metadata watchers attach", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const workspaceRoot = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-workspace-" });
      const commonMetadataRoot = yield* fs.makeTempDirectoryScoped({
        prefix: "t3-review-common-gitdir-",
      });
      const worktreeMetadataRoot = yield* fs.makeTempDirectoryScoped({
        prefix: "t3-review-worktree-gitdir-",
      });
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-base-" });
      const currentDiff = yield* Ref.make("before");
      const previewCalls = yield* Ref.make(0);
      const initialPreviewEmitted = yield* Deferred.make<void>();
      const allowWatcherStartup = yield* Deferred.make<void>();
      const watchTargets: ReadonlyArray<ReviewWatcher.ReviewWatchTarget>[] = [];
      const testReviewWatcher = {
        watch: (targets: ReadonlyArray<ReviewWatcher.ReviewWatchTarget>) => {
          watchTargets.push(targets);
          return Stream.fromEffect(Deferred.await(allowWatcherStartup)).pipe(
            Stream.map(() => ({ _tag: "Ready" as const })),
          );
        },
      };
      const driver: VcsDriver.VcsDriver["Service"] = {
        capabilities: {
          kind: "git",
          supportsWorktrees: true,
          supportsBookmarks: false,
          supportsAtomicSnapshot: false,
          supportsPushDefaultRemote: true,
          ignoreClassifier: "native",
        },
        execute: () =>
          Effect.succeed({
            exitCode: ChildProcessSpawner.ExitCode(0),
            stdout: `${worktreeMetadataRoot}\n`,
            stderr: "",
            stdoutTruncated: false,
            stderrTruncated: false,
          }),
        detectRepository: () => Effect.die("unexpected repository detection"),
        isInsideWorkTree: () => Effect.die("unexpected worktree query"),
        listWorkspaceFiles: () => Effect.die("unexpected workspace file listing"),
        listRemotes: () => Effect.die("unexpected remote listing"),
        filterIgnoredPaths: () => Effect.die("unexpected ignore filtering"),
        initRepository: () => Effect.die("unexpected repository initialization"),
        getDiffPreview: (input) =>
          Effect.gen(function* () {
            yield* Ref.update(previewCalls, (count) => count + 1);
            const diff = yield* Ref.get(currentDiff);
            return {
              cwd: input.cwd,
              generatedAt: yield* DateTime.now,
              sources: [
                {
                  id: "working-tree",
                  kind: "working-tree",
                  title: "Dirty worktree",
                  baseRef: "HEAD",
                  headRef: null,
                  diff,
                  diffHash: diff.length > 0 ? diff : "clean",
                  truncated: false,
                },
              ],
            };
          }),
      };
      const repository = {
        kind: "git" as const,
        rootPath: workspaceRoot,
        metadataPath: commonMetadataRoot,
        freshness: {
          source: "live-local" as const,
          observedAt: DateTime.nowUnsafe(),
          expiresAt: Option.none(),
        },
      };
      const layer = ReviewService.layer.pipe(
        Layer.provide(
          Layer.mock(VcsDriverRegistry.VcsDriverRegistry)({
            get: () => Effect.succeed(driver),
            detect: () => Effect.succeed({ kind: "git", repository, driver }),
            resolve: () => Effect.succeed({ kind: "git", repository, driver }),
          }),
        ),
        Layer.provide(Layer.mock(GitVcsDriver.GitVcsDriver)({})),
        Layer.provide(
          Layer.mock(ProjectionSnapshotQuery)({
            getActiveProjectByWorkspaceRoot: () => Effect.succeed(Option.none()),
          }),
        ),
        Layer.provide(Layer.succeed(ReviewWatcher.ReviewWatcher, testReviewWatcher)),
        Layer.provide(ServerConfig.layerTest(workspaceRoot, baseDir)),
        Layer.provideMerge(NodeServices.layer),
      );

      const previews = yield* Effect.gen(function* () {
        const review = yield* ReviewService.ReviewService;
        const fiber = yield* review
          .streamDiffPreview({ cwd: workspaceRoot, sourceKind: "branch-range" })
          .pipe(
            Stream.tap((preview) =>
              preview.sources[0]?.diff === "before"
                ? Deferred.succeed(initialPreviewEmitted, undefined)
                : Effect.void,
            ),
            Stream.take(2),
            Stream.runCollect,
            Effect.forkChild,
          );
        yield* Deferred.await(initialPreviewEmitted);
        assert.strictEqual(yield* Ref.get(previewCalls), 1);
        yield* Ref.set(currentDiff, "");
        yield* Deferred.succeed(allowWatcherStartup, undefined);
        return yield* Fiber.join(fiber);
      }).pipe(Effect.provide(layer), Effect.timeout("5 seconds"));

      assert.deepStrictEqual(
        Array.from(previews, (preview) => preview.sources[0]?.diff),
        ["before", ""],
      );
      assert.deepStrictEqual(watchTargets, [
        [
          {
            path: commonMetadataRoot,
            ignoredPaths: [`${commonMetadataRoot}/logs`, `${commonMetadataRoot}/objects`],
          },
          {
            path: worktreeMetadataRoot,
            ignoredPaths: [`${worktreeMetadataRoot}/logs`, `${worktreeMetadataRoot}/objects`],
          },
        ],
      ]);
      assert.strictEqual(yield* Ref.get(previewCalls), 2);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("does not recompute diffs for ignored workspace event batches", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const workspaceRoot = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-workspace-" });
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-base-" });
      const initialPreviewRead = yield* Deferred.make<void>();
      const ignoredPathsChecked = yield* Deferred.make<void>();
      const previewCalls = yield* Ref.make(0);
      const testReviewWatcher = {
        watch: () =>
          Stream.fromEffect(Deferred.await(initialPreviewRead)).pipe(
            Stream.flatMap(() =>
              Stream.fromIterable(
                Array.from(
                  { length: 10_000 },
                  () => ({ _tag: "Update", path: "node_modules/generated.js" }) as const,
                ),
              ),
            ),
          ),
      };
      const driver: VcsDriver.VcsDriver["Service"] = {
        capabilities: {
          kind: "git",
          supportsWorktrees: true,
          supportsBookmarks: false,
          supportsAtomicSnapshot: false,
          supportsPushDefaultRemote: true,
          ignoreClassifier: "native",
        },
        execute: () =>
          Effect.succeed({
            exitCode: ChildProcessSpawner.ExitCode(0),
            stdout: `${workspaceRoot}\n`,
            stderr: "",
            stdoutTruncated: false,
            stderrTruncated: false,
          }),
        detectRepository: () => Effect.die("unexpected repository detection"),
        isInsideWorkTree: () => Effect.die("unexpected worktree query"),
        listWorkspaceFiles: () => Effect.die("unexpected workspace file listing"),
        listRemotes: () => Effect.die("unexpected remote listing"),
        filterIgnoredPaths: (_cwd, relativePaths) =>
          Effect.gen(function* () {
            assert.deepStrictEqual(relativePaths, ["node_modules/generated.js"]);
            yield* Deferred.succeed(ignoredPathsChecked, undefined);
            return [];
          }),
        initRepository: () => Effect.die("unexpected repository initialization"),
        getDiffPreview: (input) =>
          Effect.gen(function* () {
            yield* Ref.update(previewCalls, (count) => count + 1);
            yield* Deferred.succeed(initialPreviewRead, undefined);
            return {
              cwd: input.cwd,
              generatedAt: yield* DateTime.now,
              sources: [
                {
                  id: "working-tree",
                  kind: "working-tree",
                  title: "Dirty worktree",
                  baseRef: "HEAD",
                  headRef: null,
                  diff: "before",
                  diffHash: "before",
                  truncated: false,
                },
              ],
            };
          }),
      };
      const repository = {
        kind: "git" as const,
        rootPath: workspaceRoot,
        metadataPath: workspaceRoot,
        freshness: {
          source: "live-local" as const,
          observedAt: DateTime.nowUnsafe(),
          expiresAt: Option.none(),
        },
      };
      const layer = ReviewService.layer.pipe(
        Layer.provide(
          Layer.mock(VcsDriverRegistry.VcsDriverRegistry)({
            get: () => Effect.succeed(driver),
            detect: () => Effect.succeed({ kind: "git", repository, driver }),
            resolve: () => Effect.succeed({ kind: "git", repository, driver }),
          }),
        ),
        Layer.provide(Layer.mock(GitVcsDriver.GitVcsDriver)({})),
        Layer.provide(
          Layer.mock(ProjectionSnapshotQuery)({
            getActiveProjectByWorkspaceRoot: () => Effect.succeed(Option.none()),
          }),
        ),
        Layer.provide(Layer.succeed(ReviewWatcher.ReviewWatcher, testReviewWatcher)),
        Layer.provide(ServerConfig.layerTest(workspaceRoot, baseDir)),
        Layer.provideMerge(NodeServices.layer),
      );

      yield* Effect.gen(function* () {
        const review = yield* ReviewService.ReviewService;
        yield* review.streamDiffPreview({ cwd: workspaceRoot }).pipe(Stream.runDrain);
        yield* Deferred.await(ignoredPathsChecked);
      }).pipe(Effect.provide(layer), Effect.timeout("5 seconds"));

      assert.strictEqual(yield* Ref.get(previewCalls), 1);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("preserves unexpected path-resolution failures", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const workspaceRoot = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-workspace-" });
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-base-" });
      const invalidCwd = `${workspaceRoot}\0invalid`;
      const detectCalls: Array<{ readonly cwd: string }> = [];

      const error = yield* Effect.gen(function* () {
        const review = yield* ReviewService.ReviewService;
        return yield* review.getDiffPreview({ cwd: invalidCwd }).pipe(Effect.flip);
      }).pipe(Effect.provide(makeLayer({ workspaceRoot, baseDir, detectCalls })));

      assert.strictEqual(error._tag, "VcsRepositoryDetectionError");
      if (error._tag !== "VcsRepositoryDetectionError") return;
      assert.strictEqual(error.operation, "ReviewService.assertWorkspaceBoundCwd.canonicalizePath");
      assert.strictEqual(error.cwd, invalidCwd);
      assert.match(error.detail, /Failed to resolve a path/);
      assert.instanceOf(error.cause, PlatformError.PlatformError);
      assert.deepStrictEqual(detectCalls, []);
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});

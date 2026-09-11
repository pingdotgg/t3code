import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as PlatformError from "effect/PlatformError";

import {
  ProjectId,
  ThreadId,
  ProviderInstanceId,
  type OrchestrationThreadShell,
  type WorkspaceRepository,
} from "@t3tools/contracts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { WorkspaceRepositories } from "../workspace/WorkspaceRepositories.ts";

import { ServerConfig } from "../config.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as ReviewService from "./ReviewService.ts";

function makeLayer(input: {
  readonly workspaceRoot: string;
  readonly baseDir: string;
  readonly registeredRoot?: string;
  readonly threads?: ReadonlyArray<OrchestrationThreadShell>;
  readonly repositories?: ReadonlyArray<WorkspaceRepository>;
  readonly detectCalls?: Array<{ readonly cwd: string }>;
}) {
  return ReviewService.layer.pipe(
    Layer.provide(
      Layer.mock(ProjectionSnapshotQuery)({
        getShellSnapshot: () =>
          Effect.succeed({
            snapshotSequence: 0,
            updatedAt: "2026-01-01T00:00:00.000Z",
            threads: input.threads ?? [],
            projects: input.registeredRoot
              ? [
                  {
                    id: ProjectId.make("project-1"),
                    title: "Workspace",
                    workspaceRoot: input.registeredRoot,
                    defaultModelSelection: null,
                    scripts: [],
                    createdAt: "2026-01-01T00:00:00.000Z",
                    updatedAt: "2026-01-01T00:00:00.000Z",
                  },
                ]
              : [],
          }),
      }),
    ),
    Layer.provide(
      Layer.succeed(WorkspaceRepositories, {
        list: () => Effect.succeed(input.repositories ?? []),
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
    Layer.provide(Layer.mock(GitVcsDriver.GitVcsDriver)({})),
    Layer.provide(ServerConfig.layerTest(input.workspaceRoot, input.baseDir)),
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
        /must stay within the configured workspace root/,
      );
      assert.deepStrictEqual(detectCalls, []);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("attributes file-content workspace violations to the file-content operation", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const workspaceRoot = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-workspace-" });
      const outsideRoot = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-outside-" });
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-base-" });
      const detectCalls: Array<{ readonly cwd: string }> = [];

      const error = yield* Effect.gen(function* () {
        const review = yield* ReviewService.ReviewService;
        return yield* review
          .getDiffFileContents({
            cwd: outsideRoot,
            sourceKind: "working-tree",
            changeType: "change",
            baseRef: "HEAD",
            headRef: null,
            oldPath: "file.ts",
            newPath: "file.ts",
          })
          .pipe(Effect.flip);
      }).pipe(Effect.provide(makeLayer({ workspaceRoot, baseDir, detectCalls })));

      assert.strictEqual(error._tag, "VcsRepositoryDetectionError");
      assert.strictEqual(error.operation, "ReviewService.getDiffFileContents");
      assert.match(
        "detail" in error ? error.detail : "",
        /must stay within the configured workspace root/,
      );
      assert.deepStrictEqual(detectCalls, []);
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

  it.effect(
    "allows only registered roots and available declared repositories for preview and hydration",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const workspaceRoot = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-workspace-" });
        const registeredRoot = yield* fs.makeTempDirectoryScoped({
          prefix: "t3-review-registered-",
        });
        const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-base-" });
        const child = `${registeredRoot}/projects/app`;
        const sibling = `${registeredRoot}/projects/unconfigured`;
        const nested = `${child}/nested-worktree`;
        const unavailable = `${registeredRoot}/projects/unavailable`;
        const outside = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-outside-" });
        const escape = `${registeredRoot}/projects/escape`;
        for (const directory of [child, sibling, nested, unavailable]) {
          yield* fs.makeDirectory(directory, { recursive: true });
        }
        yield* fs.symlink(outside, escape);
        const detectCalls: Array<{ readonly cwd: string }> = [];
        yield* Effect.gen(function* () {
          const review = yield* ReviewService.ReviewService;
          for (const cwd of [registeredRoot, child]) {
            yield* review.getDiffPreview({ cwd });
            const error = yield* review
              .getDiffFileContents({
                cwd,
                sourceKind: "working-tree",
                changeType: "change",
                baseRef: "HEAD",
                headRef: null,
                oldPath: "file.ts",
                newPath: "file.ts",
              })
              .pipe(Effect.flip);
            assert.strictEqual(error._tag, "VcsUnsupportedOperationError");
          }
          assert.strictEqual(detectCalls.length, 4);
          for (const cwd of [sibling, nested, unavailable, outside, escape]) {
            const previewError = yield* review.getDiffPreview({ cwd }).pipe(Effect.flip);
            assert.strictEqual(previewError._tag, "VcsRepositoryDetectionError");
            const hydrationError = yield* review
              .getDiffFileContents({
                cwd,
                sourceKind: "working-tree",
                changeType: "change",
                baseRef: "HEAD",
                headRef: null,
                oldPath: "file.ts",
                newPath: "file.ts",
              })
              .pipe(Effect.flip);
            assert.strictEqual(hydrationError._tag, "VcsRepositoryDetectionError");
          }
          assert.strictEqual(detectCalls.length, 4);
        }).pipe(
          Effect.provide(
            makeLayer({
              workspaceRoot,
              registeredRoot,
              baseDir,
              detectCalls,
              repositories: [
                {
                  cwd: child,
                  path: "projects/app",
                  name: "app",
                  kind: "repository",
                  available: true,
                },
                {
                  cwd: unavailable,
                  path: "projects/unavailable",
                  name: "unavailable",
                  kind: "repository",
                  available: false,
                },
                {
                  cwd: escape,
                  path: "projects/escape",
                  name: "escape",
                  kind: "repository",
                  available: true,
                },
              ],
            }),
          ),
        );
      }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("accepts only active worktrees owned by a registered project", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const workspaceRoot = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-workspace-" });
      const registeredRoot = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-registered-" });
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-base-" });
      const worktreeRoot = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-worktrees-" });
      const threads: OrchestrationThreadShell[] = [];
      for (const name of ["active", "archived", "orphan"]) {
        const worktreePath = `${worktreeRoot}/${name}`;
        yield* fs.makeDirectory(worktreePath);
        threads.push({
          id: ThreadId.make(name),
          projectId: ProjectId.make(name === "orphan" ? "missing" : "project-1"),
          title: name,
          worktreePath,
          branch: "task",
          modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
          runtimeMode: "full-access",
          interactionMode: "default",
          latestTurn: null,
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
          archivedAt: name === "archived" ? "2026-01-01T00:00:00.000Z" : null,
          settledOverride: null,
          settledAt: null,
          session: null,
          latestUserMessageAt: null,
          hasPendingApprovals: false,
          hasPendingUserInput: false,
          hasActionableProposedPlan: false,
          pullRequests: [],
        });
      }
      yield* Effect.gen(function* () {
        const review = yield* ReviewService.ReviewService;
        yield* review.getDiffPreview({ cwd: `${worktreeRoot}/active` });
        for (const name of ["archived", "orphan"]) {
          const error = yield* review
            .getDiffPreview({ cwd: `${worktreeRoot}/${name}` })
            .pipe(Effect.flip);
          assert.strictEqual(error._tag, "VcsRepositoryDetectionError");
        }
      }).pipe(Effect.provide(makeLayer({ workspaceRoot, registeredRoot, baseDir, threads })));
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

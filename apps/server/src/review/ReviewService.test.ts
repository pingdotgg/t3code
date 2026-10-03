import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as PlatformError from "effect/PlatformError";

import { ProjectId } from "@t3tools/contracts";
import { symlinksSupported } from "@t3tools/shared/testing/symlinks";
import * as ServerConfig from "../config.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as ReviewService from "./ReviewService.ts";

function layer(input: {
  readonly workspaceRoot: string;
  readonly baseDir: string;
  readonly registeredRoots?: ReadonlyArray<string>;
  readonly readProjects?: ProjectStore.ProjectStoreV2["Service"]["listShells"];
  readonly fileSystem?: FileSystem.FileSystem;
  readonly detectCalls?: Array<{ readonly cwd: string }>;
  readonly worktreesDirectory?: string;
  readonly previousWorktreesDirectories?: ReadonlyArray<string>;
}) {
  return ReviewService.layer.pipe(
    Layer.provide(
      Layer.mock(ProjectStore.ProjectStoreV2)({
        listShells:
          input.readProjects ??
          (() =>
            Effect.succeed(
              (input.registeredRoots ?? []).map((workspaceRoot, index) => ({
                id: ProjectId.make(`p${index}`),
                title: "Registered",
                workspaceRoot,
                repositoryIdentity: null,
                defaultThreadEnvMode: null,
                autoPull: false,
                faviconPath: null,
                projectIcon: null,
                defaultModelSelection: null,
                scripts: [],
                createdAt: "2026-07-01T00:00:00Z",
                updatedAt: "2026-07-01T00:00:00Z",
              })),
            )),
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
    Layer.provide(
      ServerSettings.ServerSettingsService.layerTest({
        worktreesDirectory: input.worktreesDirectory ?? "",
        previousWorktreesDirectories: [...(input.previousWorktreesDirectories ?? [])],
      }),
    ),
    Layer.provide(ServerConfig.layerTest(input.workspaceRoot, input.baseDir)),
    Layer.provide(
      input.fileSystem === undefined
        ? Layer.empty
        : Layer.succeed(FileSystem.FileSystem, input.fileSystem),
    ),
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
      }).pipe(Effect.provide(layer({ workspaceRoot, baseDir, detectCalls })));

      assert.strictEqual(error._tag, "VcsRepositoryDetectionError");
      assert.strictEqual(error.operation, "ReviewService.getDiffFileContents");
      assert.match(
        "detail" in error ? error.detail : "",
        /must stay within the configured workspace root/,
      );
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

  it.effect("allows diff preview cwd inside the configured workspace root", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const workspaceRoot = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-workspace-" });
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-base-" });
      const detectCalls: Array<{ readonly cwd: string }> = [];

      const result = yield* Effect.gen(function* () {
        const review = yield* ReviewService.ReviewService;
        return yield* review.getDiffPreview({ cwd: workspaceRoot });
      }).pipe(
        Effect.provide(
          layer({
            workspaceRoot,
            baseDir,
            detectCalls,
            readProjects: () => Effect.die("configured roots must not query project metadata"),
          }),
        ),
      );

      assert.strictEqual(result.cwd, workspaceRoot);
      assert.deepStrictEqual(result.sources, []);
      assert.deepStrictEqual(detectCalls, [{ cwd: workspaceRoot }]);
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
      }).pipe(Effect.provide(layer({ workspaceRoot, baseDir, detectCalls })));

      assert.strictEqual(error._tag, "VcsRepositoryDetectionError");
      if (error._tag !== "VcsRepositoryDetectionError") return;
      assert.strictEqual(error.operation, "ReviewService.assertWorkspaceBoundCwd.canonicalizePath");
      assert.strictEqual(error.cwd, invalidCwd);
      assert.match(error.detail, /Failed to resolve a path/);
      assert.instanceOf(error.cause, PlatformError.PlatformError);
      assert.deepStrictEqual(detectCalls, []);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("allows review previews within a live registered project outside the launch root", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const workspaceRoot = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-launch-" });
      const projectRoot = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-project-" });
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-base-" });
      const nested = `${projectRoot}/nested`;
      yield* fs.makeDirectory(nested);
      const registeredRoots = [projectRoot];
      const detectCalls: Array<{ readonly cwd: string }> = [];
      yield* Effect.gen(function* () {
        const review = yield* ReviewService.ReviewService;
        assert.deepStrictEqual((yield* review.getDiffPreview({ cwd: projectRoot })).sources, []);
        assert.deepStrictEqual((yield* review.getDiffPreview({ cwd: nested })).sources, []);
        assert.deepStrictEqual(detectCalls, [{ cwd: projectRoot }, { cwd: nested }]);
        registeredRoots.length = 0;
        const removed = yield* review.getDiffPreview({ cwd: projectRoot }).pipe(Effect.flip);
        assert.strictEqual(removed._tag, "VcsRepositoryDetectionError");
        assert.strictEqual(detectCalls.length, 2);
      }).pipe(Effect.provide(layer({ workspaceRoot, baseDir, registeredRoots, detectCalls })));
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("allows registered project roots through file-content workspace validation", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const workspaceRoot = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-launch-" });
      const projectRoot = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-project-" });
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-base-" });
      const detectCalls: Array<{ readonly cwd: string }> = [];
      const error = yield* Effect.gen(function* () {
        const review = yield* ReviewService.ReviewService;
        return yield* review
          .getDiffFileContents({
            cwd: projectRoot,
            sourceKind: "working-tree",
            changeType: "change",
            baseRef: "HEAD",
            headRef: null,
            oldPath: "file.ts",
            newPath: "file.ts",
          })
          .pipe(Effect.flip);
      }).pipe(
        Effect.provide(
          layer({ workspaceRoot, baseDir, registeredRoots: [projectRoot], detectCalls }),
        ),
      );
      // The fixture has no Git repository: validation succeeds and detection decides the error.
      assert.strictEqual(error._tag, "VcsUnsupportedOperationError");
      assert.deepStrictEqual(detectCalls, [{ cwd: projectRoot }]);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect.skipIf(!symlinksSupported)("rejects symlink escapes from registered review roots", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const workspaceRoot = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-launch-" });
      const projectRoot = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-project-" });
      const outsideRoot = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-outside-" });
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-base-" });
      yield* fs.symlink(outsideRoot, `${projectRoot}/escape`);
      const detectCalls: Array<{ readonly cwd: string }> = [];
      const error = yield* Effect.gen(function* () {
        const review = yield* ReviewService.ReviewService;
        return yield* review.getDiffPreview({ cwd: `${projectRoot}/escape` }).pipe(Effect.flip);
      }).pipe(
        Effect.provide(
          layer({ workspaceRoot, baseDir, registeredRoots: [projectRoot], detectCalls }),
        ),
      );
      assert.strictEqual(error._tag, "VcsRepositoryDetectionError");
      assert.deepStrictEqual(detectCalls, []);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("rejects traversal, sibling, and ancestor paths around registered review roots", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const workspaceRoot = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-launch-" });
      const parent = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-parent-" });
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-base-" });
      const projectRoot = `${parent}/project`;
      const sibling = `${parent}/project-sibling`;
      yield* fs.makeDirectory(projectRoot);
      yield* fs.makeDirectory(sibling);
      const detectCalls: Array<{ readonly cwd: string }> = [];
      yield* Effect.gen(function* () {
        const review = yield* ReviewService.ReviewService;
        for (const cwd of [`${projectRoot}/../project-sibling`, sibling, parent]) {
          const error = yield* review.getDiffPreview({ cwd }).pipe(Effect.flip);
          assert.strictEqual(error._tag, "VcsRepositoryDetectionError");
        }
        assert.deepStrictEqual(detectCalls, []);
      }).pipe(
        Effect.provide(
          layer({ workspaceRoot, baseDir, registeredRoots: [projectRoot], detectCalls }),
        ),
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("fails closed on project-store errors while preserving the boundary error", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const workspaceRoot = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-launch-" });
      const projectRoot = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-project-" });
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-base-" });
      const failure = new ProjectStore.ProjectStoreV2Error({
        operation: "list",
        cause: "database unavailable",
      });
      const detectCalls: Array<{ readonly cwd: string }> = [];
      const error = yield* Effect.gen(function* () {
        const review = yield* ReviewService.ReviewService;
        return yield* review.getDiffPreview({ cwd: projectRoot }).pipe(Effect.flip);
      }).pipe(
        Effect.provide(
          layer({
            workspaceRoot,
            baseDir,
            readProjects: () => Effect.fail(failure),
            detectCalls,
          }),
        ),
      );
      assert.strictEqual(error._tag, "VcsRepositoryDetectionError");
      if (error._tag !== "VcsRepositoryDetectionError") return;
      assert.strictEqual(error.operation, "ReviewService.getDiffPreview");
      assert.match(error.detail, /must stay within the configured workspace root/);
      assert.deepStrictEqual(detectCalls, []);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("an unreadable registered root does not block another project or grant access", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const workspaceRoot = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-launch-" });
      const blockedRoot = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-blocked-" });
      const projectRoot = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-project-" });
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-base-" });
      const blockedNested = `${blockedRoot}/nested`;
      yield* fs.makeDirectory(blockedNested);
      const detectCalls: Array<{ readonly cwd: string }> = [];
      yield* Effect.gen(function* () {
        const review = yield* ReviewService.ReviewService;
        yield* review.getDiffPreview({ cwd: projectRoot });
        const rejected = yield* review.getDiffPreview({ cwd: blockedNested }).pipe(Effect.flip);
        assert.strictEqual(rejected._tag, "VcsRepositoryDetectionError");
        assert.deepStrictEqual(detectCalls, [{ cwd: projectRoot }]);
      }).pipe(
        Effect.provide(
          layer({
            workspaceRoot,
            baseDir,
            registeredRoots: [blockedRoot, projectRoot],
            detectCalls,
            fileSystem: {
              ...fs,
              realPath: (path) =>
                path === blockedRoot
                  ? Effect.fail(
                      PlatformError.systemError({
                        _tag: "PermissionDenied",
                        module: "FileSystem",
                        method: "realPath",
                        pathOrDescriptor: path,
                      }),
                    )
                  : fs.realPath(path),
            },
          }),
        ),
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});

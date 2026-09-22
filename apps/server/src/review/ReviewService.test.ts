import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodePath from "@effect/platform-node/NodePath";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as PlatformError from "effect/PlatformError";
import * as Path from "effect/Path";
import { symlinksSupported } from "@t3tools/shared/testing/symlinks";

import { ServerConfig } from "../config.ts";
import { expandHomePath } from "../pathExpansion.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as ReviewService from "./ReviewService.ts";

function makeLayer(input: {
  readonly workspaceRoot: string;
  readonly baseDir: string;
  readonly detectCalls?: Array<{ readonly cwd: string }>;
  readonly worktreeBaseDirectory?: string;
}) {
  return ReviewService.layer.pipe(
    Layer.provide(
      Layer.orDie(
        ServerSettings.layerTest({ worktreeBaseDirectory: input.worktreeBaseDirectory ?? "" }),
      ),
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

  it.effect("allows diff preview cwd inside the configured worktrees directory", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const workspaceRoot = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-workspace-" });
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-base-" });
      const worktreeRoot = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-worktrees-" });
      const worktreeCwd = `${worktreeRoot}/feature-branch`;
      yield* fs.makeDirectory(worktreeCwd, { recursive: true });
      const detectCalls: Array<{ readonly cwd: string }> = [];

      const result = yield* Effect.gen(function* () {
        const review = yield* ReviewService.ReviewService;
        return yield* review.getDiffPreview({ cwd: worktreeCwd });
      }).pipe(
        Effect.provide(
          makeLayer({
            workspaceRoot,
            baseDir,
            detectCalls,
            worktreeBaseDirectory: worktreeRoot,
          }),
        ),
      );

      assert.strictEqual(result.cwd, worktreeCwd);
      assert.deepStrictEqual(detectCalls, [{ cwd: worktreeCwd }]);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("rejects a configured worktree root on a different Windows volume", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const workspaceRoot = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-workspace-" });
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-base-" });
      const configuredWorktreesDir = "/tmp/t3-review-configured-worktrees";
      const winPath = yield* Path.Path.pipe(Effect.provide(NodePath.layerWin32));
      const configuredRootRequest = winPath.resolve(configuredWorktreesDir);
      let configuredRoot = "D:\\";
      const simulatedFileSystem = FileSystem.FileSystem.of({
        ...fs,
        realPath: (target: string) =>
          Effect.succeed(target === configuredRootRequest ? configuredRoot : target),
      });
      const config = yield* Effect.service(ServerConfig).pipe(
        Effect.provide(ServerConfig.layerTest(workspaceRoot, baseDir)),
      );
      const detectCalls: Array<{ readonly cwd: string }> = [];
      const reviewLayer = ReviewService.layer.pipe(
        Layer.provide(
          Layer.orDie(ServerSettings.layerTest({ worktreeBaseDirectory: configuredWorktreesDir })),
        ),
        Layer.provide(
          Layer.mock(VcsDriverRegistry.VcsDriverRegistry)({
            get: () => Effect.die("unexpected VCS registry get"),
            resolve: () => Effect.die("unexpected VCS registry resolve"),
            detect: (request) =>
              Effect.sync(() => {
                detectCalls.push({ cwd: request.cwd });
                return null;
              }),
          }),
        ),
        Layer.provide(Layer.mock(GitVcsDriver.GitVcsDriver)({})),
        Layer.provide(Layer.succeed(ServerConfig, config)),
        Layer.provide(Layer.succeed(FileSystem.FileSystem, simulatedFileSystem)),
        Layer.provide(NodePath.layerWin32),
      );

      const rejected = yield* Effect.gen(function* () {
        const review = yield* ReviewService.ReviewService;
        return yield* review.getDiffPreview({ cwd: "D:\\repo" }).pipe(Effect.flip);
      }).pipe(Effect.provide(reviewLayer));
      assert.equal(rejected._tag, "VcsRepositoryDetectionError");
      assert.deepStrictEqual(detectCalls, []);

      configuredRoot = "D:\\worktrees";
      const result = yield* Effect.gen(function* () {
        const review = yield* ReviewService.ReviewService;
        return yield* review.getDiffPreview({ cwd: "D:\\worktrees\\repo" });
      }).pipe(Effect.provide(reviewLayer));
      assert.equal(result.cwd, "D:\\worktrees\\repo");
      assert.deepStrictEqual(detectCalls, [{ cwd: "D:\\worktrees\\repo" }]);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("still rejects a cwd outside the configured worktrees directory", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const workspaceRoot = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-workspace-" });
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-base-" });
      const worktreeRoot = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-worktrees-" });
      const outsideRoot = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-outside-" });
      const detectCalls: Array<{ readonly cwd: string }> = [];

      const error = yield* Effect.gen(function* () {
        const review = yield* ReviewService.ReviewService;
        return yield* review.getDiffPreview({ cwd: outsideRoot }).pipe(Effect.flip);
      }).pipe(
        Effect.provide(
          makeLayer({
            workspaceRoot,
            baseDir,
            detectCalls,
            worktreeBaseDirectory: worktreeRoot,
          }),
        ),
      );

      assert.strictEqual(error._tag, "VcsRepositoryDetectionError");
      assert.deepStrictEqual(detectCalls, []);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  for (const target of ["filesystem root", "home directory"] as const) {
    it.effect.skipIf(!symlinksSupported)(
      `rejects a configured worktrees directory that resolves to the ${target}`,
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const workspaceRoot = yield* fs.makeTempDirectoryScoped({
            prefix: "t3-review-workspace-",
          });
          const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-base-" });
          const home = expandHomePath("~");
          const outsideRoot =
            target === "home directory"
              ? yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-outside-", directory: home })
              : yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-outside-" });
          const link = path.join(baseDir, "link");
          yield* fs.symlink(
            target === "home directory" ? home : path.parse(outsideRoot).root,
            link,
          );
          const detectCalls: Array<{ readonly cwd: string }> = [];

          const error = yield* Effect.gen(function* () {
            const review = yield* ReviewService.ReviewService;
            return yield* review.getDiffPreview({ cwd: outsideRoot }).pipe(Effect.flip);
          }).pipe(
            Effect.provide(
              makeLayer({ workspaceRoot, baseDir, detectCalls, worktreeBaseDirectory: link }),
            ),
          );

          assert.equal(error._tag, "VcsRepositoryDetectionError");
          assert.deepStrictEqual(detectCalls, []);
        }).pipe(Effect.provide(NodeServices.layer)),
    );
  }

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

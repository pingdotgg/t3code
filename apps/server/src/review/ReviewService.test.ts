import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import { symlinksSupported } from "@t3tools/shared/testing/symlinks";

import { ServerConfig } from "../config.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as ReviewService from "./ReviewService.ts";

function makeLayer(input: {
  readonly workspaceRoot: string;
  readonly baseDir: string;
  readonly detectCalls?: Array<{ readonly cwd: string }>;
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

  it.effect.skipIf(!symlinksSupported)(
    "enforces a requested project workspace root with canonical paths",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const serverRoot = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-server-" });
        const projectRoot = path.join(serverRoot, "workspace");
        const nestedRepository = path.join(projectRoot, "backend");
        const siblingRepository = path.join(serverRoot, "sibling-repository");
        const outsideRepository = yield* fs.makeTempDirectoryScoped({
          prefix: "t3-review-outside-",
        });
        yield* fs.makeDirectory(projectRoot);
        yield* fs.makeDirectory(nestedRepository);
        yield* fs.makeDirectory(siblingRepository);
        const siblingLink = path.join(projectRoot, "frontend");
        const outsideLink = path.join(projectRoot, "external");
        yield* fs.symlink(siblingRepository, siblingLink);
        yield* fs.symlink(outsideRepository, outsideLink);
        const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-base-" });
        const detectCalls: Array<{ readonly cwd: string }> = [];

        const result = yield* Effect.gen(function* () {
          const review = yield* ReviewService.ReviewService;
          const unscoped = yield* review.getDiffPreview({ cwd: siblingLink });
          const siblingError = yield* review
            .getDiffPreview({ cwd: siblingLink, workspaceRoot: projectRoot })
            .pipe(Effect.flip);
          const contentsError = yield* review
            .getDiffFileContents({
              cwd: siblingLink,
              workspaceRoot: projectRoot,
              sourceKind: "working-tree",
              changeType: "change",
              baseRef: "HEAD",
              headRef: null,
              oldPath: "file.ts",
              newPath: "file.ts",
            })
            .pipe(Effect.flip);
          const nested = yield* review.getDiffPreview({
            cwd: nestedRepository,
            workspaceRoot: projectRoot,
          });
          const outsideError = yield* review
            .getDiffPreview({ cwd: outsideLink, workspaceRoot: projectRoot })
            .pipe(Effect.flip);
          return { unscoped, siblingError, contentsError, nested, outsideError };
        }).pipe(Effect.provide(makeLayer({ workspaceRoot: serverRoot, baseDir, detectCalls })));

        assert.deepStrictEqual(result.unscoped.sources, []);
        assert.strictEqual(result.siblingError._tag, "VcsRepositoryDetectionError");
        if (result.siblingError._tag !== "VcsRepositoryDetectionError") return;
        assert.match(result.siblingError.detail, /selected repository must stay inside/);
        assert.strictEqual(result.contentsError._tag, "VcsRepositoryDetectionError");
        if (result.contentsError._tag !== "VcsRepositoryDetectionError") return;
        assert.match(result.contentsError.detail, /selected repository must stay inside/);
        assert.deepStrictEqual(result.nested.sources, []);
        assert.strictEqual(result.outsideError._tag, "VcsRepositoryDetectionError");
        if (result.outsideError._tag !== "VcsRepositoryDetectionError") return;
        assert.match(result.outsideError.detail, /configured workspace root/);
        assert.deepStrictEqual(detectCalls, [{ cwd: siblingLink }, { cwd: nestedRepository }]);
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

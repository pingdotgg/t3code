import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";

import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as ReviewService from "./ReviewService.ts";

function makeLayer(detectCalls: Array<{ readonly cwd: string }>) {
  return ReviewService.layer.pipe(
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
  );
}

describe("ReviewService", () => {
  it.effect("passes an arbitrary local project root to VCS detection", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const projectRoot = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-project-" });
      const detectCalls: Array<{ readonly cwd: string }> = [];

      const result = yield* Effect.gen(function* () {
        const review = yield* ReviewService.ReviewService;
        return yield* review.getDiffPreview({ cwd: projectRoot });
      }).pipe(Effect.provide(makeLayer(detectCalls)));

      assert.strictEqual(result.cwd, projectRoot);
      assert.deepStrictEqual(result.sources, []);
      assert.deepStrictEqual(detectCalls, [{ cwd: projectRoot }]);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("checks VCS support for file expansion in an arbitrary local project", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const projectRoot = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-project-" });
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
      }).pipe(Effect.provide(makeLayer(detectCalls)));

      assert.strictEqual(error._tag, "VcsUnsupportedOperationError");
      assert.strictEqual(error.operation, "ReviewService.getDiffFileContents");
      assert.deepStrictEqual(detectCalls, [{ cwd: projectRoot }]);
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});

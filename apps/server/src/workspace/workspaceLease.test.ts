import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { symlinksSupported } from "@t3tools/shared/testing/symlinks";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { resolveWorkspacePath } from "./workspaceLease.ts";

it.layer(NodeServices.layer)("resolveWorkspacePath", (it) => {
  it.effect.each([
    "existing",
    "missing",
    ...(symlinksSupported
      ? ([
          "direct-alias",
          "parent-alias",
          "missing-parent-alias",
          "dangling-alias",
          "missing-descendants",
        ] as const)
      : []),
  ] as const)("resolves a physical checkout path, %s", (kind) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const temporary = yield* fs.makeTempDirectoryScoped({ prefix: "t3-workspace-path-" });
      const root = yield* fs.realPath(temporary);
      const checkouts = path.join(root, "checkouts");
      yield* fs.makeDirectory(checkouts);
      const missing = [
        "missing",
        "missing-parent-alias",
        "dangling-alias",
        "missing-descendants",
      ].includes(kind);
      const target = path.join(
        checkouts,
        ...(kind === "missing-descendants" ? ["nested"] : []),
        "feature",
      );
      if (!missing) yield* fs.makeDirectory(target);
      let input = target;
      if (kind === "direct-alias" || kind === "dangling-alias") {
        input = path.join(root, "alias");
        yield* fs.symlink("checkouts/feature", input);
      } else if (
        kind === "parent-alias" ||
        kind === "missing-parent-alias" ||
        kind === "missing-descendants"
      ) {
        const alias = path.join(root, "alias");
        yield* fs.symlink(checkouts, alias);
        input = path.join(alias, ...(kind === "missing-descendants" ? ["nested"] : []), "feature");
      }
      assert.strictEqual(yield* resolveWorkspacePath(input), target);
    }),
  );

  if (symlinksSupported) {
    it.effect("fails on a link cycle", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-workspace-cycle-" });
        const first = path.join(root, "first");
        const second = path.join(root, "second");
        yield* fs.symlink(second, first);
        yield* fs.symlink(first, second);
        assert.isTrue(Exit.isFailure(yield* Effect.exit(resolveWorkspacePath(first))));
      }),
    );
  }
});

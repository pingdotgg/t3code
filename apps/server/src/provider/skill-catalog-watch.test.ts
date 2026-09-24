import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import {
  skillCatalogWatchEventAffectsTarget,
  skillCatalogWatchTargets,
} from "./skillCatalogWatch.ts";

describe("skillCatalogWatchTargets", () => {
  it.effect("retargets from the nearest existing ancestor to the requested directory", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const cwd = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-skill-watch-target-",
      });
      const claudeDirectory = path.join(cwd, ".claude");
      const skillsDirectory = path.join(claudeDirectory, "skills");
      const watchPaths = [{ path: skillsDirectory, recursive: true }] as const;

      const fromWorkspace = yield* skillCatalogWatchTargets(watchPaths);
      assert.deepStrictEqual(fromWorkspace, [
        {
          path: cwd,
          recursive: false,
          expectedPaths: [claudeDirectory],
        },
      ]);
      assert.strictEqual(
        skillCatalogWatchEventAffectsTarget(path, fromWorkspace[0]!, {
          _tag: "Create",
          path: ".claude",
        }),
        true,
      );
      assert.strictEqual(
        skillCatalogWatchEventAffectsTarget(path, fromWorkspace[0]!, {
          _tag: "Update",
          path: "src",
        }),
        false,
      );

      yield* fileSystem.makeDirectory(claudeDirectory);
      assert.deepStrictEqual(yield* skillCatalogWatchTargets(watchPaths), [
        {
          path: claudeDirectory,
          recursive: false,
          expectedPaths: [skillsDirectory],
        },
      ]);

      yield* fileSystem.makeDirectory(skillsDirectory);
      assert.deepStrictEqual(yield* skillCatalogWatchTargets(watchPaths), [
        {
          path: skillsDirectory,
          recursive: true,
          expectedPaths: undefined,
        },
      ]);
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});

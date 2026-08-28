import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { writeFileStringAtomically } from "./atomicWrite.ts";

it.effect("does not fail after the target file is committed", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-atomic-write-" });
      const target = path.join(root, "settings.json");
      const cleanupFailureFileSystem = {
        ...fileSystem,
        makeTempDirectoryScoped: (options) =>
          Effect.acquireRelease(fileSystem.makeTempDirectory(options), () =>
            Effect.die(new Error("temporary directory cleanup failed")),
          ),
      } satisfies FileSystem.FileSystem;

      const exit = yield* writeFileStringAtomically({
        filePath: target,
        contents: "committed",
      }).pipe(Effect.provideService(FileSystem.FileSystem, cleanupFailureFileSystem), Effect.exit);

      assert.isTrue(Exit.isSuccess(exit));
      assert.strictEqual(yield* fileSystem.readFileString(target), "committed");
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

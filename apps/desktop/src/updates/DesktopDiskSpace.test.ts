import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as DesktopDiskSpace from "./DesktopDiskSpace.ts";

describe("DesktopDiskSpace", () => {
  it.effect("sums nested files without following symlinks", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const diskSpace = yield* DesktopDiskSpace.DesktopDiskSpace;
      const root = yield* fileSystem.makeTempDirectoryScoped();
      const outside = yield* fileSystem.makeTempDirectoryScoped();
      yield* fileSystem.makeDirectory(path.join(root, "resources", "app"), { recursive: true });
      yield* fileSystem.writeFileString(path.join(root, "app.exe"), "x".repeat(100));
      yield* fileSystem.writeFileString(
        path.join(root, "resources", "app", "a.js"),
        "x".repeat(20),
      );
      yield* fileSystem.writeFileString(path.join(outside, "big.bin"), "x".repeat(5000));
      yield* fileSystem.symlink(path.join(outside, "big.bin"), path.join(root, "big-link"));
      yield* fileSystem.symlink(outside, path.join(root, "outside-link"));

      assert.equal(yield* diskSpace.directoryBytes(root), 120);
      assert.isTrue(
        Exit.isFailure(yield* Effect.exit(diskSpace.directoryBytes(path.join(root, "missing")))),
      );
    }).pipe(Effect.scoped, Effect.provide(Layer.merge(DesktopDiskSpace.layer, NodeServices.layer))),
  );
});

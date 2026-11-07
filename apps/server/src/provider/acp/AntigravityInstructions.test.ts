import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import * as HostProcess from "@t3tools/shared/HostProcess";

import { readAntigravityInstructions } from "./AntigravityInstructions.ts";

it.effect("reads only bounded regular instruction files and skips missing files", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.makeTempDirectoryScoped();
    const file = path.join(root, "AGENTS.md");
    const limit = 256 * 1024;
    yield* fs.writeFileString(file, "a".repeat(limit));
    assert.lengthOf((yield* readAntigravityInstructions(file))!, limit);
    yield* fs.writeFileString(file, "a".repeat(limit + 1));
    assert.isTrue(Exit.isFailure(yield* Effect.exit(readAntigravityInstructions(file))));
    assert.isUndefined(yield* readAntigravityInstructions(path.join(root, "missing")));
    assert.isTrue(Exit.isFailure(yield* Effect.exit(readAntigravityInstructions(root))));
    if ((yield* HostProcess.Platform) !== "win32") {
      const device = path.join(root, "GEMINI.md");
      yield* fs.symlink("/dev/zero", device);
      assert.isTrue(Exit.isFailure(yield* Effect.exit(readAntigravityInstructions(device))));
    }
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

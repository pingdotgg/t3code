#!/usr/bin/env node

import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

const decodeJson = Schema.decodeEffect(Schema.UnknownFromJsonString);

const program = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const repoRoot = path.resolve(import.meta.dirname, "..");
  const sourcePath = path.join(repoRoot, "provider-compatibility.v1.json");
  const destinationPath = path.join(
    repoRoot,
    "apps",
    "marketing",
    "public",
    "provider-compatibility.v1.json",
  );

  yield* Effect.flatMap(fs.readFileString(sourcePath), decodeJson);

  yield* fs.makeDirectory(path.dirname(destinationPath), { recursive: true });
  yield* fs.copyFile(sourcePath, destinationPath);

  yield* Effect.logInfo(
    `Mirrored ${path.relative(repoRoot, sourcePath)} to ${path.relative(repoRoot, destinationPath)}.`,
  );
});

if (import.meta.main) {
  program.pipe(Effect.provide(NodeServices.layer), NodeRuntime.runMain);
}

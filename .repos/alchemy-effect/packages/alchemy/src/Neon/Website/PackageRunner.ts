import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import {
  packageWebsiteArtifact,
  type WebsiteArtifactProps,
} from "./Artifact.ts";

NodeRuntime.runMain(
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const inputPath = process.argv[2];
    const outputPath = process.argv[3];
    if (!inputPath || !outputPath)
      return yield* Effect.fail(new Error("Missing Website packaging paths"));
    const source = yield* fs.readFileString(inputPath);
    const props = yield* Effect.try(
      () => JSON.parse(source) as WebsiteArtifactProps,
    );
    const { archive } = yield* packageWebsiteArtifact(props);
    yield* fs.writeFile(outputPath, archive);
  }).pipe(
    Effect.scoped,
    Effect.provide(NodeServices.layer),
    Effect.provide(FetchHttpClient.layer),
  ),
);

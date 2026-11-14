import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Layer from "effect/Layer";
import { packageWebsiteArtifact, type WebsiteArtifactProps } from "./Artifact.ts";

export class PackageRunnerInvalidProps extends Data.TaggedError("PackageRunnerInvalidProps")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

NodeRuntime.runMain(
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const inputPath = process.argv[2];
    const outputPath = process.argv[3];
    if (!inputPath || !outputPath)
      return yield* new PackageRunnerInvalidProps({ message: "Missing Website packaging paths" });
    const source = yield* fs.readFileString(inputPath);
    const props = yield* Effect.try(() => JSON.parse(source) as WebsiteArtifactProps);
    const { archive } = yield* packageWebsiteArtifact(props);
    yield* fs.writeFile(outputPath, archive);
  }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, FetchHttpClient.layer))),
);

import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { nodeFileTrace } from "@vercel/nft";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import type { TraceInput } from "./Trace.ts";

NodeRuntime.runMain(
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const inputPath = process.argv[2];
    const outputPath = process.argv[3];
    if (!inputPath || !outputPath)
      return yield* Effect.fail(new Error("Missing dependency trace paths"));
    const source = yield* fs.readFileString(inputPath);
    const input = yield* Effect.try(() => JSON.parse(source) as TraceInput);
    const trace = (seeds: string[], emitGlobs: boolean) =>
      Effect.tryPromise(() =>
        nodeFileTrace(seeds, {
          base: input.base,
          processCwd: input.root,
          conditions: ["node", "production"],
          // Next's manifests already trace its runtime without dev bundlers.
          ignore: input.next
            ? (file) =>
                file.replaceAll("\\", "/").includes("/node_modules/next/")
            : undefined,
          analysis: {
            emitGlobs,
            computeFileReferences: true,
            evaluatePureExpressions: true,
          },
        }),
      );
    const result = yield* trace(input.seeds, true);
    const stateFiles = [...result.fileList].filter((file) =>
      file.split(/[\\/]/).includes(".alchemy"),
    );
    if (stateFiles.length > 0) {
      // NFT's asset globs can sweep up unrelated build/state directories.
      // Trace without globs to retain explicit state dependencies: packaging
      // must still reject those, including references through symlinks.
      // Include modules discovered by a wildcard import too: their explicit
      // references to state must not disappear with the wildcard expansion.
      const explicit = yield* trace(
        [
          ...new Set([
            ...input.seeds,
            ...[...result.fileList]
              .filter(
                (file) =>
                  /\.[cm]?[jt]sx?$/.test(file) &&
                  !file.split(/[\\/]/).includes(".alchemy"),
              )
              .map((file) => path.resolve(input.base, file)),
          ]),
        ],
        false,
      );
      for (const file of stateFiles) {
        if (!explicit.fileList.has(file)) result.fileList.delete(file);
      }
    }
    yield* fs.writeFileString(outputPath, JSON.stringify([...result.fileList]));
  }).pipe(Effect.provide(NodeServices.layer)),
);

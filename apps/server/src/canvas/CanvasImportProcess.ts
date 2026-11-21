import { CanvasAsset, CanvasImportError, CanvasNode } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { resolveSelfInvocation, selfInvocationArgs } from "@t3tools/shared/nodeRuntime";
import * as NodeURL from "node:url";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as ProcessRunner from "../processRunner.ts";

// Only the isolated importer writes this file. Validate nodes there one at a
// time, instead of building another complete schema traversal in the server.
const ImportedDocument = Schema.Struct({
  name: Schema.String,
  rootIds: Schema.Array(Schema.String),
  nodes: Schema.Record(
    Schema.String,
    Schema.declare((value): value is CanvasNode => typeof value === "object" && value !== null),
  ),
  assets: Schema.Record(
    Schema.String,
    Schema.declare((value): value is CanvasAsset => typeof value === "object" && value !== null),
  ),
  warnings: Schema.Array(Schema.String),
});
const decodeResult = Schema.decodeUnknownEffect(Schema.fromJsonString(ImportedDocument));
const isImportError = Schema.is(CanvasImportError);

/** Parsing and its temporary object graph live in a disposable, bounded process. */
export const importCanvasInProcess = Effect.fn("CanvasImportProcess.import")(function* (
  fileName: string,
  source: Uint8Array | string,
) {
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const runtime = yield* resolveSelfInvocation();
      const self = import.meta.url.endsWith("/CanvasImportProcess.ts")
        ? { ...runtime, entrypoint: NodeURL.fileURLToPath(new URL("../bin.ts", import.meta.url)) }
        : runtime;
      const env = yield* HostProcess.Environment;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-canvas-import-" });
      const input = typeof source === "string" ? source : path.join(dir, "input");
      const output = path.join(dir, "output.json");
      if (typeof source !== "string") yield* fs.writeFile(input, source);
      const result = yield* Effect.flatMap(ProcessRunner.ProcessRunner, (runner) =>
        runner.run({
          command: self.command,
          args: selfInvocationArgs(self, ["__canvas-import", input, output, fileName]),
          env: { ...env, ELECTRON_RUN_AS_NODE: "1", NODE_OPTIONS: "--max-old-space-size=1024" },
          timeout: "2 minutes",
          maxOutputBytes: 4096,
          outputMode: "truncate",
        }),
      ).pipe(Effect.provide(ProcessRunner.layer));
      if (result.code !== 0) {
        return yield* new CanvasImportError({
          fileName,
          reason:
            "The import exceeded its memory budget or could not be decoded. Export fewer pages or remove unused assets and retry.",
        });
      }
      return yield* decodeResult(yield* fs.readFileString(output));
    }),
  ).pipe(
    Effect.mapError((cause) =>
      isImportError(cause)
        ? cause
        : new CanvasImportError({
            fileName,
            reason:
              "The isolated import failed or timed out. The server is still available; retry with fewer pages.",
            cause,
          }),
    ),
  );
});

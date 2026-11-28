// @effect-diagnostics nodeBuiltinImport:off -- the history worker is an isolated process runtime boundary.
import * as NodeChildProcess from "node:child_process";
import * as NodeStream from "node:stream";
import * as NodeStreamPromises from "node:stream/promises";
import * as NodeURL from "node:url";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as HostProcess from "@t3tools/shared/HostProcess";

import type { BuildResourceTelemetryHistoryInput } from "./ResourceTelemetryHistory.ts";
import { decodeHistoryResult, encodeHistoryMetadata } from "./ResourceTelemetryHistoryWorker.ts";

class HistoryAggregationError extends Schema.TaggedError<HistoryAggregationError>()(
  "HistoryAggregationError",
  { cause: Schema.Defect() },
) {}

export const readResourceTelemetryHistory = Effect.fn("ResourceTelemetry.aggregateHistory")(
  function* (input: BuildResourceTelemetryHistoryInput) {
    const executable = yield* HostProcess.ExecutablePath;
    const isExecutable = yield* HostProcess.IsExecutable;
    const environment = yield* HostProcess.Environment;
    const entry = NodeURL.fileURLToPath(
      new URL(import.meta.url.endsWith(".ts") ? "../bin.ts" : "./bin.mjs", import.meta.url),
    );
    const output = yield* Effect.tryPromise({
      try: (signal) =>
        new Promise<string>((resolve, reject) => {
          let pipeComplete = Promise.resolve();
          let pipeFailure: unknown;
          const worker = NodeChildProcess.execFile(
            executable,
            [...(isExecutable ? [] : [entry]), "__resource-telemetry-history"],
            {
              signal,
              timeout: 30_000,
              // Native retention caps raw data at 64 MiB; allow JSON escaping and summary overhead.
              maxBuffer: 512 * 1024 * 1024,
              encoding: "utf8",
              windowsHide: true,
              env: { ...environment, ELECTRON_RUN_AS_NODE: "1" },
            },
            (error, stdout, stderr) => {
              void pipeComplete.then(() => {
                if (error) reject(Object.assign(error, { stderr }));
                else if (pipeFailure !== undefined) reject(pipeFailure);
                else resolve(stdout);
              });
            },
          );
          function* chunks() {
            yield encodeHistoryMetadata(input).slice(0, -1) + ',"snapshots":[';
            for (const [index, snapshot] of input.snapshots.entries()) {
              yield (index === 0 ? "" : ",") + JSON.stringify(snapshot);
            }
            yield "]}";
          }
          // Pipe backpressure bounds serialization work instead of stringifying all retained records at once.
          pipeComplete = NodeStreamPromises.pipeline(
            NodeStream.Readable.from(chunks()),
            worker.stdin!,
          ).catch((cause) => {
            pipeFailure = cause;
            worker.kill();
          });
        }),
      catch: (cause) => new HistoryAggregationError({ cause }),
    });
    return yield* Effect.try({
      try: () => decodeHistoryResult(output),
      catch: (cause) => new HistoryAggregationError({ cause }),
    });
  },
);

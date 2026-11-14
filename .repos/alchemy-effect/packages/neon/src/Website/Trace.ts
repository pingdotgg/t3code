import { logChildLine } from "alchemy/Util/LogRecord";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as ChildProcess from "effect/process/ChildProcess";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

export class TraceOperationFailed extends Data.TaggedError("TraceOperationFailed")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export interface TraceInput {
  readonly seeds: string[];
  readonly base: string;
  readonly root: string;
  readonly next: boolean;
}

/** Keep dependency-parser heaps outside the long-lived deployment process. */
export const traceWebsiteFiles = Effect.fn(function* (input: TraceInput) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = yield* fs.makeTempDirectoryScoped({
    prefix: "alchemy-neon-trace-",
  });
  const inputPath = path.join(directory, "input.json");
  const outputPath = path.join(directory, "output.json");
  yield* fs.writeFileString(inputPath, JSON.stringify(input));
  const runner = yield* path.fromFileUrl(
    new URL(
      import.meta.url.endsWith(".ts") ? "./TraceRunner.ts" : "./TraceRunner.js",
      import.meta.url,
    ),
  );
  const child = yield* ChildProcess.make(
    "node",
    ["--max-old-space-size=1536", runner, inputPath, outputPath],
    { stdin: "ignore", stdout: "ignore", stderr: "pipe" },
  );
  // The runner's diagnostics become log records instead of raw terminal writes.
  const [code] = yield* Effect.all(
    [
      child.exitCode,
      child.stderr.pipe(
        Stream.decodeText,
        Stream.splitLines,
        Stream.runForEach((line) => logChildLine(line, { stream: "stderr" })),
      ),
    ],
    { concurrency: "unbounded" },
  );
  if (code !== 0)
    return yield* new TraceOperationFailed({ message: `Website dependency trace exited ${code}` });
  return yield* fs
    .readFileString(outputPath)
    .pipe(
      Effect.flatMap(
        Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Array(Schema.String))),
      ),
    );
}, Effect.scoped);

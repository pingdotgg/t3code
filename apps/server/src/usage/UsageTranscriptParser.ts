import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import { TRANSCRIPT_USAGE_FORMATS } from "./usageTranscriptFormats.ts";
import { readTranscriptRecords, type TranscriptParseResult } from "./usageTranscriptReader.ts";
import type { TranscriptParseRequest } from "./usageTranscriptWorker.ts";

export type { TranscriptParseRequest } from "./usageTranscriptWorker.ts";

/** Results align with requests; null means the file could not be read. */
export class UsageTranscriptParser extends Context.Service<
  UsageTranscriptParser,
  {
    readonly parse: (
      requests: readonly TranscriptParseRequest[],
    ) => Effect.Effect<ReadonlyArray<TranscriptParseResult | null>>;
  }
>()("t3/usage/UsageTranscriptParser") {}

const parseInProcess = (request: TranscriptParseRequest) => {
  const format = TRANSCRIPT_USAGE_FORMATS.get(request.provider);
  return format === undefined
    ? Effect.succeed(null)
    : Effect.promise(() => readTranscriptRecords(request.path, format, request.resumeFrom));
};

const IN_PROCESS_CONCURRENCY = 4;
// A spawn costs more than parsing a few changed files on the server; large scans split across cores.
const MIN_CHILD_BYTES = 8 * 1024 * 1024;
const MAX_CHILDREN = 2;
const MIN_BYTES_PER_CHILD = 32 * 1024 * 1024;

export const layerInProcess = Layer.succeed(
  UsageTranscriptParser,
  UsageTranscriptParser.of({
    parse: Effect.fn("UsageTranscriptParser.parse")((requests) =>
      Effect.forEach(requests, parseInProcess, { concurrency: IN_PROCESS_CONCURRENCY }),
    ),
  }),
);

const encodeRequests = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodeLine = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));

/**
 * Parsing a cold 30-day window is seconds of JSON.parse and regex work; a child
 * process keeps it off the server's event loop and heap. Lines arrive per file,
 * so the server decodes in small slices. Files the child did not report fall
 * back to in-process parsing.
 */
export const make = Effect.fn("UsageTranscriptParser.make")(function* (options?: {
  readonly minChildBytes?: number;
}) {
  const minChildBytes = options?.minChildBytes ?? MIN_CHILD_BYTES;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const path = yield* Path.Path;
  const executable = yield* HostProcess.ExecutablePath;
  const isExecutable = yield* HostProcess.IsExecutable;
  const environment = yield* HostProcess.Environment;
  const children = yield* Semaphore.make(MAX_CHILDREN);
  // In a bundle import.meta.url is bin.mjs; development and tests use this source module.
  const entry = yield* path.fromFileUrl(
    new URL(import.meta.url.endsWith(".ts") ? "../bin.ts" : "./bin.mjs", import.meta.url),
  );

  const parseInChild = Effect.fn("UsageTranscriptParser.parseInChild")(
    function* (
      requests: readonly TranscriptParseRequest[],
      indices: readonly number[],
      results: Array<TranscriptParseResult | null | undefined>,
    ) {
      const handle = yield* spawner.spawn(
        ChildProcess.make(executable, [...(isExecutable ? [] : [entry]), "__usage-transcripts"], {
          env: { ...environment, ELECTRON_RUN_AS_NODE: "1" },
          stdin: Stream.make(encodeRequests(indices.map((index) => requests[index]))).pipe(
            Stream.encodeText,
          ),
          stderr: "ignore",
          windowsHide: true,
        }),
      );
      yield* handle.stdout.pipe(
        Stream.decodeText(),
        Stream.splitLines,
        Stream.runForEach((line) =>
          Effect.sync(() => {
            const decoded = decodeLine(line);
            if (!Array.isArray(decoded)) return;
            const [shardIndex, result] = decoded;
            const index = indices[shardIndex];
            // The child is this server's own code, so its results are trusted as parsed.
            if (Number.isInteger(shardIndex) && index !== undefined) {
              results[index] = result as TranscriptParseResult | null;
            }
          }),
        ),
      );
      const code = yield* handle.exitCode;
      if (code !== 0) {
        yield* Effect.logWarning("Usage transcript parser exited early.", { code });
      }
    },
    Effect.scoped,
    Effect.catchCause((cause) =>
      Effect.logWarning("Usage transcript parser failed; parsing in process.", { cause }),
    ),
  );

  const parse = Effect.fn("UsageTranscriptParser.parse")(function* (
    requests: readonly TranscriptParseRequest[],
  ) {
    const results: Array<TranscriptParseResult | null | undefined> = Array.from({
      length: requests.length,
    });
    const unreadBytes = requests.reduce(
      (sum, request) => sum + Math.max(0, request.size - (request.resumeFrom?.resumeOffset ?? 0)),
      0,
    );
    // Interleave so both children see a similar mix of large and small files.
    const shardCount =
      unreadBytes < minChildBytes || requests.length === 0
        ? 0
        : Math.min(MAX_CHILDREN, Math.ceil(unreadBytes / MIN_BYTES_PER_CHILD));
    const shards = Array.from({ length: shardCount }, (_, shard) =>
      requests.flatMap((_, index) => (index % shardCount === shard ? [index] : [])),
    );
    if (shardCount > 0) {
      yield* Effect.forEach(
        shards,
        (indices) => children.withPermit(parseInChild(requests, indices, results)),
        { concurrency: "unbounded", discard: true },
      );
    }
    return yield* Effect.forEach(
      requests,
      (request, index) => {
        const result = results[index];
        return result === undefined ? parseInProcess(request) : Effect.succeed(result);
      },
      { concurrency: IN_PROCESS_CONCURRENCY },
    );
  });

  return UsageTranscriptParser.of({ parse });
});

export const layer = Layer.effect(UsageTranscriptParser, make());

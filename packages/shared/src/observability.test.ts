import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Arr from "effect/Array";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Order from "effect/Order";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as References from "effect/References";
import * as Scheduler from "effect/Scheduler";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import * as Tracer from "effect/Tracer";

import {
  causeErrorTag,
  compactTraceAttributes,
  errorTag,
  makeLocalFileTracer,
  makeTraceSink,
  type TraceRecord,
  type TraceSinkFlushStats,
  truncateTraceAttributes,
} from "./observability.ts";

describe("errorTag", () => {
  it("reports structural tags without retaining arbitrary values", () => {
    assert.equal(errorTag({ _tag: "AcpRequestError" }), "AcpRequestError");
    assert.equal(errorTag(new TypeError("secret-token-value")), "TypeError");
    assert.equal(errorTag({ _tag: "secret token value" }), "TaggedError");
  });
});

describe("causeErrorTag", () => {
  it("reports the tagged failure value instead of the Cause reason wrapper", () => {
    assert.equal(
      causeErrorTag(Cause.fail({ _tag: "ServerAuthInvalidCredentialError" })),
      "ServerAuthInvalidCredentialError",
    );
  });

  it("reports structural cause kinds when no typed failure exists", () => {
    assert.equal(causeErrorTag(Cause.die(new Error("unexpected"))), "Die");
    assert.equal(causeErrorTag(Cause.interrupt()), "Interrupt");
  });
});

const TraceRecordLine = Schema.Struct({
  name: Schema.String,
  spanId: Schema.String,
  parentSpanId: Schema.optional(Schema.String),
  attributes: Schema.Record(Schema.String, Schema.Unknown),
  events: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      attributes: Schema.Record(Schema.String, Schema.Unknown),
    }),
  ),
  exit: Schema.optional(
    Schema.Struct({
      _tag: Schema.String,
    }),
  ),
});

const decodeTraceRecordLine = Schema.decodeUnknownSync(Schema.fromJsonString(TraceRecordLine));

const makeRecord = (name: string, suffix = ""): TraceRecord => ({
  type: "effect-span",
  name,
  traceId: `trace-${name}-${suffix}`,
  spanId: `span-${name}-${suffix}`,
  sampled: true,
  kind: "internal",
  startTimeUnixNano: "1",
  endTimeUnixNano: "2",
  durationMs: 1,
  attributes: {
    payload: suffix,
  },
  events: [],
  links: [],
  exit: {
    _tag: "Success",
  },
});

const readTraceRecords = Effect.fn("readTraceRecords")(function* (tracePath: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  return (yield* fileSystem.readFileString(tracePath))
    .trim()
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => decodeTraceRecordLine(line));
});

const makeTestLayer = (tracePath: string) =>
  Layer.mergeAll(
    Layer.effect(
      Tracer.Tracer,
      makeLocalFileTracer({
        filePath: tracePath,
        maxBytes: 1024 * 1024,
        maxFiles: 2,
        batchWindowMs: 10_000,
      }),
    ),
    Logger.layer([Logger.tracerLogger], { mergeWithExisting: false }),
    Layer.succeed(References.MinimumLogLevel, "Info"),
  );

const nodeServicesIt = it.layer(NodeServices.layer);

describe("truncateTraceAttributes", () => {
  it("clamps oversized strings at any depth without mutating the input", () => {
    const stack = "s".repeat(2_000);
    const attributes = {
      "db.query.text": "q".repeat(2_000),
      short: "ok",
      error: { name: "Error", stack, nested: ["a".repeat(2_000)] },
    };
    const truncated = truncateTraceAttributes(attributes);

    assert.equal((truncated["db.query.text"] as string).length, 200 + "…[truncated]".length);
    assert.equal(truncated["short"], "ok");
    const error = truncated["error"] as { stack: string; nested: Array<string> };
    assert.equal(error.stack.length, 500 + "…[truncated]".length);
    assert.equal(error.nested[0]?.length, 500 + "…[truncated]".length);
    // Input is untouched: the live span's attributes are shared.
    assert.equal(attributes.error.stack, stack);
  });

  it("returns the same reference when nothing exceeds the limits", () => {
    const attributes = { short: "ok", nested: { fine: "also ok" } };
    assert.equal(truncateTraceAttributes(attributes), attributes);
  });
});

describe("observability", () => {
  it("normalizes circular arrays, maps, and sets without recursing forever", () => {
    const array: Array<unknown> = ["alpha"];
    array.push(array);

    const map = new Map<string, unknown>();
    map.set("self", map);

    const set = new Set<unknown>();
    set.add(set);

    assert.deepStrictEqual(
      compactTraceAttributes({
        array,
        map,
        set,
      }),
      {
        array: ["alpha", "[Circular]"],
        map: { self: "[Circular]" },
        set: ["[Circular]"],
      },
    );
  });

  it("normalizes invalid dates without throwing", () => {
    // @effect-diagnostics-next-line globalDate:off
    const invalidDate = new Date("not-a-real-date");
    assert.deepStrictEqual(
      compactTraceAttributes({
        invalidDate,
      }),
      {
        invalidDate: "Invalid Date",
      },
    );
  });

  nodeServicesIt("node services", (it) => {
    it.effect("flushes buffered trace records on close", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const tempDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-trace-sink-" });
          const tracePath = path.join(tempDir, "shared.trace.ndjson");

          const sink = yield* makeTraceSink({
            filePath: tracePath,
            maxBytes: 1024,
            maxFiles: 2,
            batchWindowMs: 10_000,
          });

          sink.push(makeRecord("alpha"));
          sink.push(makeRecord("beta"));
          yield* sink.close();

          const lines = yield* readTraceRecords(tracePath);

          assert.equal(lines.length, 2);
          assert.equal(lines[0]?.name, "alpha");
          assert.equal(lines[1]?.name, "beta");
        }),
      ),
    );

    it.effect("keeps trace backlog bounded while an asynchronous write is stalled", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const tempDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-trace-sink-" });
          const tracePath = path.join(tempDir, "shared.trace.ndjson");
          const writeStarted = Promise.withResolvers<void>();
          const releaseWrite = Promise.withResolvers<void>();
          const writtenChunks: Array<string> = [];

          const sink = yield* makeTraceSink({
            filePath: tracePath,
            maxBytes: 10 * 1024 * 1024,
            maxFiles: 2,
            batchWindowMs: 10_000,
            writeAsync: async (chunk) => {
              writeStarted.resolve();
              await releaseWrite.promise;
              writtenChunks.push(chunk.toString());
            },
          });

          for (let index = 0; index < 256; index += 1) {
            sink.push(makeRecord("first", String(index)));
          }
          yield* Effect.promise(() => writeStarted.promise);
          for (let index = 0; index < 10_000; index += 1) {
            sink.push(makeRecord("queued", String(index)));
          }

          releaseWrite.resolve();
          yield* sink.close();

          const lines = writtenChunks
            .join("")
            .trimEnd()
            .split("\n")
            .map((line) => decodeTraceRecordLine(line));
          assert.equal(lines.length, 256 + 8_192);
          assert.equal(lines[256]?.name, "queued");
          assert.include(lines[256]?.spanId ?? "", "1808");
          assert.include(lines.at(-1)?.spanId ?? "", "9999");
        }),
      ),
    );

    it.effect("automatically drains a threshold reached during an in-flight write", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const tempDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-trace-sink-" });
          const tracePath = path.join(tempDir, "shared.trace.ndjson");
          const firstWriteStarted = Promise.withResolvers<void>();
          const releaseFirstWrite = Promise.withResolvers<void>();
          const secondWriteStarted = Promise.withResolvers<void>();
          const writtenChunks: Array<string> = [];
          let writeCount = 0;

          const sink = yield* makeTraceSink({
            filePath: tracePath,
            maxBytes: 10 * 1024 * 1024,
            maxFiles: 2,
            batchWindowMs: 10_000,
            writeAsync: async (chunk) => {
              writeCount += 1;
              if (writeCount === 1) {
                firstWriteStarted.resolve();
                await releaseFirstWrite.promise;
              } else if (writeCount === 2) {
                secondWriteStarted.resolve();
              }
              writtenChunks.push(chunk.toString());
            },
          });

          for (let index = 0; index < 256; index += 1) {
            sink.push(makeRecord("first", String(index)));
          }
          yield* Effect.promise(() => firstWriteStarted.promise);

          for (let index = 0; index < 256; index += 1) {
            sink.push(makeRecord("second", String(index)));
          }
          releaseFirstWrite.resolve();

          // The second write must begin without an explicit flush, close, or
          // batch-window tick.
          yield* Effect.promise(() => secondWriteStarted.promise);
          yield* sink.close();

          const lines = writtenChunks
            .join("")
            .trimEnd()
            .split("\n")
            .map((line) => decodeTraceRecordLine(line));
          assert.equal(writeCount, 2);
          assert.equal(lines.length, 512);
          assert.equal(lines[0]?.name, "first");
          assert.equal(lines[255]?.name, "first");
          assert.equal(lines[256]?.name, "second");
          assert.equal(lines[511]?.name, "second");
        }),
      ),
    );

    it.effect("ignores records pushed after close starts while preserving earlier records", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const tempDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-trace-sink-" });
          const tracePath = path.join(tempDir, "shared.trace.ndjson");
          const writeStarted = Promise.withResolvers<void>();
          const releaseWrite = Promise.withResolvers<void>();
          const writtenChunks: Array<string> = [];

          const sink = yield* makeTraceSink({
            filePath: tracePath,
            maxBytes: 10 * 1024 * 1024,
            maxFiles: 2,
            batchWindowMs: 10_000,
            writeAsync: async (chunk) => {
              writeStarted.resolve();
              await releaseWrite.promise;
              writtenChunks.push(chunk.toString());
            },
          });

          sink.push(makeRecord("before-close"));
          const closeFiber = yield* sink.close().pipe(Effect.forkChild);
          yield* Effect.promise(() => writeStarted.promise);
          sink.push(makeRecord("after-close"));
          releaseWrite.resolve();
          yield* Fiber.join(closeFiber);
          yield* sink.close();

          const lines = writtenChunks
            .join("")
            .trimEnd()
            .split("\n")
            .map((line) => decodeTraceRecordLine(line));
          assert.deepEqual(
            lines.map((line) => line.name),
            ["before-close"],
          );
        }),
      ),
    );

    it.effect("reports a completed close only once", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const tempDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-trace-sink-" });
          const tracePath = path.join(tempDir, "shared.trace.ndjson");
          const reported = yield* Ref.make(0);

          const sink = yield* makeTraceSink({
            filePath: tracePath,
            maxBytes: 1024,
            maxFiles: 2,
            batchWindowMs: 10_000,
            onFlush: () => Ref.update(reported, (count) => count + 1),
          });

          sink.push(makeRecord("close-once"));
          yield* sink.close();
          yield* sink.close();

          assert.equal(yield* Ref.get(reported), 1);
        }),
      ),
    );

    it.effect("retries a failed close write without losing accepted trace records", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const tempDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-trace-sink-" });
          const tracePath = path.join(tempDir, "shared.trace.ndjson");
          const writtenChunks: Array<string> = [];
          const firstWriteStarted = Promise.withResolvers<void>();
          let writeCount = 0;

          const sink = yield* makeTraceSink({
            filePath: tracePath,
            maxBytes: 1024,
            maxFiles: 2,
            batchWindowMs: 10_000,
            writeAsync: async (chunk) => {
              writeCount += 1;
              if (writeCount === 1) {
                firstWriteStarted.resolve();
                throw new Error("transient trace write failure");
              }
              writtenChunks.push(chunk.toString());
            },
          });

          sink.push(makeRecord("retry-on-close"));
          const closeFiber = yield* sink.close().pipe(Effect.forkChild);
          yield* Effect.promise(() => firstWriteStarted.promise);
          yield* TestClock.adjust("25 millis");
          yield* Fiber.join(closeFiber);

          const records = writtenChunks
            .join("")
            .trimEnd()
            .split("\n")
            .map((line) => decodeTraceRecordLine(line));
          assert.equal(writeCount, 2);
          assert.deepEqual(
            records.map((record) => record.name),
            ["retry-on-close"],
          );
        }),
      ),
    );

    it.effect("waits for threshold follow-up records before close completes", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const tempDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-trace-sink-" });
          const tracePath = path.join(tempDir, "shared.trace.ndjson");
          const firstWriteStarted = Promise.withResolvers<void>();
          const releaseFirstWrite = Promise.withResolvers<void>();
          const secondWriteStarted = Promise.withResolvers<void>();
          const releaseSecondWrite = Promise.withResolvers<void>();
          const writtenChunks: Array<string> = [];
          let writeCount = 0;

          const sink = yield* makeTraceSink({
            filePath: tracePath,
            maxBytes: 1_048_576,
            maxFiles: 2,
            batchWindowMs: 10_000,
            writeAsync: async (chunk) => {
              writeCount += 1;
              if (writeCount === 1) {
                firstWriteStarted.resolve();
                await releaseFirstWrite.promise;
              } else {
                secondWriteStarted.resolve();
                await releaseSecondWrite.promise;
              }
              writtenChunks.push(chunk.toString());
            },
          });

          for (let index = 0; index < 256; index += 1) {
            sink.push(makeRecord("before-close", String(index)));
          }
          yield* Effect.promise(() => firstWriteStarted.promise);
          for (let index = 0; index < 256; index += 1) {
            sink.push(makeRecord("during-write", String(index)));
          }

          const closeFiber = yield* sink.close().pipe(Effect.forkChild);
          releaseFirstWrite.resolve();
          yield* Effect.promise(() => secondWriteStarted.promise);
          assert.isUndefined(closeFiber.pollUnsafe());
          releaseSecondWrite.resolve();
          yield* Fiber.join(closeFiber);

          const records = writtenChunks
            .join("")
            .trimEnd()
            .split("\n")
            .map((line) => decodeTraceRecordLine(line));
          assert.equal(writeCount, 2);
          assert.equal(records.length, 512);
          assert.deepEqual(
            records.slice(0, 256).map((record) => record.name),
            Array.from({ length: 256 }, () => "before-close"),
          );
          assert.deepEqual(
            records.slice(256).map((record) => record.name),
            Array.from({ length: 256 }, () => "during-write"),
          );
        }),
      ),
    );

    it.effect("bounds close when an asynchronous write never completes", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const tempDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-trace-sink-" });
          const tracePath = path.join(tempDir, "shared.trace.ndjson");
          const writeStarted = Promise.withResolvers<void>();

          const sink = yield* makeTraceSink({
            filePath: tracePath,
            maxBytes: 1024,
            maxFiles: 2,
            batchWindowMs: 10_000,
            writeAsync: () => {
              writeStarted.resolve();
              return new Promise(() => undefined);
            },
          });

          sink.push(makeRecord("stalled-close"));
          const closeFiber = yield* sink.close().pipe(Effect.forkChild);
          yield* Effect.promise(() => writeStarted.promise);
          yield* TestClock.adjust("2 seconds");
          yield* Fiber.join(closeFiber);

          sink.push(makeRecord("ignored-after-timeout"));
          assert.equal(yield* fileSystem.exists(tracePath), false);
        }),
      ),
    );

    it.effect("bounds close when every asynchronous write rejects", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const tempDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-trace-sink-" });
          const tracePath = path.join(tempDir, "shared.trace.ndjson");
          const firstWriteStarted = Promise.withResolvers<void>();
          let writeCount = 0;

          const sink = yield* makeTraceSink({
            filePath: tracePath,
            maxBytes: 1024,
            maxFiles: 2,
            batchWindowMs: 10_000,
            writeAsync: () => {
              writeCount += 1;
              firstWriteStarted.resolve();
              return Promise.reject(new Error("permanent trace write failure"));
            },
          });

          sink.push(makeRecord("rejected-close"));
          const closeFiber = yield* sink.close().pipe(Effect.forkChild);
          yield* Effect.promise(() => firstWriteStarted.promise);
          yield* TestClock.adjust("2 seconds");
          yield* Fiber.join(closeFiber);

          assert.isAtLeast(writeCount, 2);
          const attemptsAfterClose = writeCount;
          yield* TestClock.adjust("1 second");
          assert.equal(writeCount, attemptsAfterClose);
          assert.equal(yield* fileSystem.exists(tracePath), false);
        }),
      ),
    );

    it.effect("does not run a pre-admitted flush after close completes", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const tempDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-trace-sink-" });
          const tracePath = path.join(tempDir, "shared.trace.ndjson");
          const firstWriteStarted = Promise.withResolvers<void>();
          let writeCount = 0;

          const sink = yield* makeTraceSink({
            filePath: tracePath,
            maxBytes: 1024,
            maxFiles: 2,
            batchWindowMs: 10_000,
            writeAsync: () => {
              writeCount += 1;
              firstWriteStarted.resolve();
              return Promise.reject(new Error("permanent trace write failure"));
            },
          });

          const scheduled: Array<() => void> = [];
          let schedulerChecks = 0;
          const scheduler: Scheduler.Scheduler = {
            executionMode: "async",
            shouldYield: () => {
              schedulerChecks += 1;
              return schedulerChecks === 2;
            },
            makeDispatcher: () => ({
              scheduleTask: (task) => {
                scheduled.push(task);
              },
              flush: () => {
                while (scheduled.length > 0) scheduled.shift()?.();
              },
            }),
          };

          sink.push(makeRecord("close-before-stale-flush"));
          const staleFlush = yield* sink.flush.pipe(
            Effect.provideService(Scheduler.Scheduler, scheduler),
            Effect.forkChild({ startImmediately: true }),
          );
          assert.isUndefined(staleFlush.pollUnsafe());
          assert.equal(scheduled.length, 1);

          const closeFiber = yield* sink.close().pipe(Effect.forkChild);
          yield* Effect.promise(() => firstWriteStarted.promise);
          yield* TestClock.adjust("2 seconds");
          yield* Fiber.join(closeFiber);
          const writesAtClose = writeCount;

          scheduled.shift()?.();
          yield* Fiber.join(staleFlush);

          assert.equal(writeCount, writesAtClose);
        }),
      ),
    );

    it.effect("reports successful logical trace writes", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const tempDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-trace-sink-" });
          const tracePath = path.join(tempDir, "shared.trace.ndjson");
          const reported = yield* Ref.make<ReadonlyArray<TraceSinkFlushStats>>([]);

          const sink = yield* makeTraceSink({
            filePath: tracePath,
            maxBytes: 1024,
            maxFiles: 2,
            batchWindowMs: 10_000,
            onFlush: (stats) => Ref.update(reported, (current) => [...current, stats]),
          });

          sink.push(makeRecord("attributed"));
          yield* sink.flush;

          const stats = yield* Ref.get(reported);
          assert.equal(stats.length, 1);
          assert.equal(stats[0]?.count, 1);
          assert.isAbove(stats[0]?.logicalWriteBytes ?? 0, 0);
        }),
      ),
    );

    it.effect("rotates the trace file when the configured max size is exceeded", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const tempDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-trace-sink-" });
          const tracePath = path.join(tempDir, "shared.trace.ndjson");

          const sink = yield* makeTraceSink({
            filePath: tracePath,
            maxBytes: 500,
            maxFiles: 2,
            batchWindowMs: 10_000,
          });

          for (let index = 0; index < 8; index += 1) {
            sink.push(makeRecord("rotate", `${index}-${"x".repeat(48)}`));
            yield* sink.flush;
          }
          yield* sink.close();

          const matchingFiles = Arr.sort(
            (yield* fileSystem.readDirectory(tempDir)).filter(
              (entry) =>
                entry === "shared.trace.ndjson" || entry.startsWith("shared.trace.ndjson."),
            ),
            Order.String,
          );

          assert.equal(
            matchingFiles.some((entry) => entry === "shared.trace.ndjson.1"),
            true,
          );
          assert.equal(
            matchingFiles.some((entry) => entry === "shared.trace.ndjson.3"),
            false,
          );
        }),
      ),
    );

    it.effect("keeps every trace file within the configured limit for threshold flushes", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const tempDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-trace-sink-" });
          const tracePath = path.join(tempDir, "shared.trace.ndjson");
          const maxBytes = 1_024;

          const sink = yield* makeTraceSink({
            filePath: tracePath,
            maxBytes,
            maxFiles: 2,
            batchWindowMs: 10_000,
          });

          for (let index = 0; index < 256; index += 1) {
            sink.push(makeRecord("threshold", `${index}-${"x".repeat(48)}`));
          }
          yield* sink.close();

          const matchingFiles = (yield* fileSystem.readDirectory(tempDir)).filter(
            (entry) => entry === "shared.trace.ndjson" || entry.startsWith("shared.trace.ndjson."),
          );
          assert.include(matchingFiles, "shared.trace.ndjson.1");
          for (const entry of matchingFiles) {
            const stat = yield* fileSystem.stat(path.join(tempDir, entry));
            assert.isAtMost(Number(stat.size), maxBytes, entry);
          }
        }),
      ),
    );

    it.effect("drops a single trace record that cannot fit within the configured limit", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const tempDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-trace-sink-" });
          const tracePath = path.join(tempDir, "shared.trace.ndjson");
          const maxBytes = 1_024;

          const sink = yield* makeTraceSink({
            filePath: tracePath,
            maxBytes,
            maxFiles: 2,
            batchWindowMs: 10_000,
          });

          sink.push(makeRecord("oversized", "x".repeat(maxBytes * 2)));
          sink.push(makeRecord("retained"));
          yield* sink.close();

          const records = yield* readTraceRecords(tracePath);
          const stat = yield* fileSystem.stat(tracePath);
          assert.deepEqual(
            records.map((record) => record.name),
            ["retained"],
          );
          assert.isAtMost(Number(stat.size), maxBytes);
        }),
      ),
    );

    it.effect("drops only the invalid trace record when serialization fails", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const tempDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-trace-sink-" });
          const tracePath = path.join(tempDir, "shared.trace.ndjson");

          const sink = yield* makeTraceSink({
            filePath: tracePath,
            maxBytes: 1024,
            maxFiles: 2,
            batchWindowMs: 10_000,
          });

          const circular: Array<unknown> = [];
          circular.push(circular);

          sink.push(makeRecord("alpha"));
          sink.push({
            ...makeRecord("invalid"),
            attributes: {
              circular,
            },
          } as TraceRecord);
          sink.push(makeRecord("beta"));
          yield* sink.close();

          const lines = yield* readTraceRecords(tracePath);

          assert.deepStrictEqual(
            lines.map((line) => line.name),
            ["alpha", "beta"],
          );
        }),
      ),
    );

    it.effect("writes nested spans to disk and captures log messages as span events", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const tempDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-local-tracer-" });
          const tracePath = path.join(tempDir, "shared.trace.ndjson");

          yield* Effect.scoped(
            Effect.gen(function* () {
              const program = Effect.gen(function* () {
                yield* Effect.annotateCurrentSpan({
                  "demo.parent": true,
                });
                yield* Effect.logInfo("parent event");
                yield* Effect.gen(function* () {
                  yield* Effect.annotateCurrentSpan({
                    "demo.child": true,
                  });
                  yield* Effect.logInfo("child event");
                }).pipe(Effect.withSpan("child-span"));
              }).pipe(Effect.withSpan("parent-span"));

              yield* program.pipe(Effect.provide(makeTestLayer(tracePath)));
            }),
          );

          const records = yield* readTraceRecords(tracePath);
          assert.equal(records.length, 2);

          const parent = records.find((record) => record.name === "parent-span");
          const child = records.find((record) => record.name === "child-span");

          assert.notEqual(parent, undefined);
          assert.notEqual(child, undefined);
          if (!parent || !child) {
            return;
          }

          assert.equal(child.parentSpanId, parent.spanId);
          assert.equal(parent.attributes["demo.parent"], true);
          assert.equal(child.attributes["demo.child"], true);
          assert.equal(
            parent.events.some((event) => event.name === "parent event"),
            true,
          );
          assert.equal(
            child.events.some((event) => event.name === "child event"),
            true,
          );
          assert.equal(
            child.events.some((event) => event.attributes["effect.logLevel"] === "INFO"),
            true,
          );
        }),
      ),
    );

    it.effect("serializes interrupted spans with an interrupted exit status", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const tempDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-local-tracer-" });
          const tracePath = path.join(tempDir, "shared.trace.ndjson");

          yield* Effect.scoped(
            Effect.exit(
              Effect.interrupt.pipe(
                Effect.withSpan("interrupt-span"),
                Effect.provide(makeTestLayer(tracePath)),
              ),
            ),
          );

          const records = yield* readTraceRecords(tracePath);
          assert.equal(records.length, 1);
          assert.equal(records[0]?.name, "interrupt-span");
          assert.equal(records[0]?.exit?._tag, "Interrupted");
        }),
      ),
    );
  });
});

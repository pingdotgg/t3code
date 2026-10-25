import { assert, describe, expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as References from "effect/References";
import * as Schema from "effect/Schema";
import * as Tracer from "effect/Tracer";

import {
  causeErrorTag,
  compactTraceAttributes,
  errorTag,
  makeLocalFileTracer,
  makeTraceSink,
  type EffectTraceRecord,
  type TraceRecord,
  OtlpHeadersFromString,
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

const layerTest = (tracePath: string) =>
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
    assert.equal(attributes.error.stack, stack);
  });
});

describe("observability", () => {
  it.effect(
    "preserves successful results without retaining them in sampled or unsampled spans",
    () =>
      Effect.gen(function* () {
        for (const sampled of [true, false]) {
          const delegates: Array<Tracer.Span> = [];
          const records: Array<EffectTraceRecord> = [];
          const tracer = yield* makeLocalFileTracer({
            filePath: "unused",
            maxBytes: 1024,
            maxFiles: 1,
            batchWindowMs: 10_000,
            sink: {
              filePath: "unused",
              push: (record) => {
                if (record.type === "effect-span") records.push(record);
              },
              flush: Effect.void,
              close: () => Effect.void,
            },
            delegate: Tracer.make({
              span: (options) => {
                const span = new Tracer.NativeSpan({ ...options, sampled });
                delegates.push(span);
                return span;
              },
            }),
          });
          const payload = { turnItems: [{ output: [{ text: "synthetic-result" }] }] };
          let span: Tracer.Span | undefined;
          const result = yield* Effect.gen(function* () {
            span = yield* Effect.currentSpan;
            return payload;
          }).pipe(
            Effect.withSpan("read-thread-projection"),
            Effect.provideService(Tracer.Tracer, tracer),
          );
          assert.strictEqual(result, payload);
          assert.isDefined(span);
          for (const completed of [span!, ...delegates]) {
            assert.equal(completed.status._tag, "Ended");
            if (completed.status._tag === "Ended") {
              assert.deepStrictEqual(completed.status.exit, Exit.void);
            }
          }
          assert.deepStrictEqual(
            records.map((record) => record.exit),
            sampled ? [{ _tag: "Success" }] : [],
          );
        }
      }).pipe(Effect.provide(NodeServices.layer)),
  );

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

  nodeServicesIt("node services", (it) => {
    it.effect(
      "keeps trace producers responsive during a slow write, bounds the backlog, and drains on close",
      () =>
        Effect.scoped(
          Effect.gen(function* () {
            const fs = yield* FileSystem.FileSystem;
            const path = yield* Path.Path;
            const directory = yield* fs.makeTempDirectoryScoped({
              prefix: "t3-trace-backpressure-",
            });
            const tracePath = path.join(directory, "trace.ndjson");
            const started = yield* Deferred.make<void>();
            const release = yield* Deferred.make<void>();
            const closed = yield* Ref.make(false);
            const sink = yield* makeTraceSink({
              filePath: tracePath,
              maxBytes: 5_000_000,
              maxFiles: 2,
              batchWindowMs: 10_000,
            }).pipe(
              Effect.provideService(FileSystem.FileSystem, {
                ...fs,
                writeFile: (file, data, options) =>
                  Effect.gen(function* () {
                    yield* Deferred.succeed(started, undefined);
                    yield* Deferred.await(release);
                    yield* fs.writeFile(file, data, options);
                  }),
              }),
            );
            sink.push(makeRecord("first"));
            const flushing = yield* Effect.forkChild(sink.flush);
            yield* Deferred.await(started);
            for (let index = 0; index < 2_000; index++)
              sink.push(makeRecord("small", String(index)));
            for (let index = 0; index < 3; index++)
              sink.push({ ...makeRecord("large"), attributes: { payload: "x".repeat(2_000_000) } });
            const closing = yield* Effect.forkChild(
              sink.close().pipe(Effect.tap(() => Ref.set(closed, true))),
            );
            yield* Effect.yieldNow;
            assert.isFalse(yield* Ref.get(closed));
            yield* Deferred.succeed(release, undefined);
            yield* Fiber.join(flushing);
            yield* Fiber.join(closing);
            const records = yield* readTraceRecords(tracePath);
            assert.deepStrictEqual(
              records.map((record) => record.name),
              ["first", ...Array.from({ length: 2_000 }, () => "small"), "large", "large"],
            );
            assert.isTrue(yield* Ref.get(closed));
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

              yield* program.pipe(Effect.provide(layerTest(tracePath)));
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
                Effect.provide(layerTest(tracePath)),
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

describe("OtlpHeadersFromString", () => {
  const decode = Schema.decodeUnknownSync(OtlpHeadersFromString);

  it.each([
    {
      name: "decodes percent-encoded values",
      input: "authorization=Basic%20abc%3D%3D,x-tenant=t3",
      expected: { authorization: "Basic abc==", "x-tenant": "t3" },
    },
    {
      name: "ignores whitespace around separators",
      input: "authorization=Basic%20abc%3D%3D, x-tenant = t3 ,",
      expected: { authorization: "Basic abc==", "x-tenant": "t3" },
    },
    {
      name: "keeps literal equals signs inside a value",
      input: "authorization=Bearer abc==",
      expected: { authorization: "Bearer abc==" },
    },
    {
      name: "keeps an empty value",
      input: "x-empty=",
      expected: { "x-empty": "" },
    },
  ])("$name", ({ input, expected }) => {
    expect(decode(input)).toEqual(expected);
  });

  it.each([
    { name: "rejects a pair without a separator", input: "authorization" },
    { name: "rejects a pair without a key", input: "=value" },
    { name: "rejects a malformed percent-encoding", input: "authorization=%E0" },
  ])("$name", ({ input }) => {
    expect(() => decode(input)).toThrow();
  });
});

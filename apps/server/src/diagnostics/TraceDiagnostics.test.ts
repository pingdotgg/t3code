import { assert, describe, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as PlatformError from "effect/PlatformError";
import * as References from "effect/References";
import * as Stream from "effect/Stream";

import * as TraceDiagnostics from "./TraceDiagnostics.ts";

function ns(ms: number): string {
  return String(BigInt(ms) * 1_000_000n);
}

function record(input: {
  readonly name: string;
  readonly traceId: string;
  readonly spanId: string;
  readonly startMs: number;
  readonly durationMs: number;
  readonly exit?: { readonly _tag: "Success" | "Failure" | "Interrupted"; readonly cause?: string };
  readonly events?: ReadonlyArray<unknown>;
}) {
  return JSON.stringify({
    type: "effect-span",
    name: input.name,
    traceId: input.traceId,
    spanId: input.spanId,
    sampled: true,
    kind: "internal",
    startTimeUnixNano: ns(input.startMs),
    endTimeUnixNano: ns(input.startMs + input.durationMs),
    durationMs: input.durationMs,
    attributes: {},
    events: input.events ?? [],
    links: [],
    exit: input.exit ?? { _tag: "Success" },
  });
}

const traceFilePath = "/tmp/server.trace.ndjson";
const readAt = DateTime.makeUnsafe("2026-05-05T10:00:00.000Z");

/** Aggregates whole lines in memory, the way diagnostics read traces before streaming. */
function aggregateLines(lines: ReadonlyArray<string>) {
  const aggregator = TraceDiagnostics.makeTraceDiagnosticsAggregator();
  lines.forEach(aggregator.addLine);
  return aggregator.finish({
    traceFilePath,
    scannedFilePaths: TraceDiagnostics.toRotatedTracePaths(traceFilePath, 1),
    readAt,
  });
}

/** Reads the trace file and one rotated backup through a fake file system. */
function readTraces(fileSystem: Partial<FileSystem.FileSystem>) {
  return TraceDiagnostics.readTraceDiagnostics({ traceFilePath, maxFiles: 1, readAt }).pipe(
    Effect.provide(TraceDiagnostics.layer.pipe(Layer.provide(FileSystem.layerNoop(fileSystem)))),
  );
}

describe("TraceDiagnostics", () => {
  it.effect("aggregates failures, slow spans, log levels, and parse errors", () =>
    Effect.sync(() => {
      const diagnostics = aggregateLines([
        record({
          name: "server.getConfig",
          traceId: "trace-a",
          spanId: "span-a",
          startMs: 1_000,
          durationMs: 50,
        }),
        "not-json",
        record({
          name: "orchestration.dispatch",
          traceId: "trace-b",
          spanId: "span-b",
          startMs: 2_000,
          durationMs: 1_500,
          exit: { _tag: "Failure", cause: "Provider crashed" },
          events: [
            {
              name: "provider failed",
              timeUnixNano: ns(3_400),
              attributes: { "effect.logLevel": "Error" },
            },
          ],
        }),
        record({
          name: "orchestration.dispatch",
          traceId: "trace-c",
          spanId: "span-c",
          startMs: 4_000,
          durationMs: 250,
          exit: { _tag: "Failure", cause: "Provider crashed" },
        }),
        record({
          name: "git.status",
          traceId: "trace-d",
          spanId: "span-d",
          startMs: 5_000,
          durationMs: 25,
          exit: { _tag: "Interrupted", cause: "Interrupted" },
          events: [
            {
              name: "status delayed",
              timeUnixNano: ns(5_010),
              attributes: { "effect.logLevel": "Warning" },
            },
          ],
        }),
      ]);

      assert.equal(diagnostics.recordCount, 4);
      assert.equal(DateTime.formatIso(diagnostics.readAt), "2026-05-05T10:00:00.000Z");
      assert.equal(
        Option.match(diagnostics.firstSpanAt, {
          onNone: () => null,
          onSome: DateTime.formatIso,
        }),
        "1970-01-01T00:00:01.000Z",
      );
      assert.equal(
        Option.match(diagnostics.lastSpanAt, {
          onNone: () => null,
          onSome: DateTime.formatIso,
        }),
        "1970-01-01T00:00:05.025Z",
      );
      assert.equal(diagnostics.parseErrorCount, 1);
      assert.equal(diagnostics.failureCount, 2);
      assert.equal(diagnostics.interruptionCount, 1);
      assert.equal(diagnostics.slowSpanCount, 1);
      assert.equal(diagnostics.logLevelCounts.Error, 1);
      assert.equal(diagnostics.logLevelCounts.Warning, 1);
      assert.equal(diagnostics.commonFailures[0]?.name, "orchestration.dispatch");
      assert.equal(diagnostics.commonFailures[0]?.count, 2);
      assert.equal(diagnostics.latestFailures[0]?.traceId, "trace-c");
      assert.equal(diagnostics.slowestSpans[0]?.traceId, "trace-b");
      assert.equal(diagnostics.latestWarningAndErrorLogs[0]?.message, "status delayed");
      assert.equal(diagnostics.topSpansByCount[0]?.name, "orchestration.dispatch");
    }),
  );

  it.effect("returns a not-found diagnostic when no files are available", () =>
    Effect.gen(function* () {
      const diagnostics = yield* readTraces({});

      assert.equal(diagnostics.recordCount, 0);
      assert.equal(Option.getOrUndefined(diagnostics.error)?.kind, "trace-file-not-found");
    }),
  );

  it.effect("streams rotated files into the same result as reading them whole", () =>
    Effect.gen(function* () {
      // CRLF and LF endings plus multi-byte text, served one byte per chunk so
      // chunks split lines, line endings, and characters.
      const files = new Map([
        [
          `${traceFilePath}.1`,
          [
            record({
              name: "server.getConfig",
              traceId: "trace-a",
              spanId: "span-a",
              startMs: 1_000,
              durationMs: 50,
            }),
            "not-json",
            record({
              name: "orchestration.dispatch",
              traceId: "trace-b",
              spanId: "span-b",
              startMs: 2_000,
              durationMs: 1_500,
              exit: { _tag: "Failure", cause: "Provider crashed: café 🔥" },
            }),
            "",
          ].join("\r\n"),
        ],
        [
          traceFilePath,
          [
            record({
              name: "git.status",
              traceId: "trace-c",
              spanId: "span-c",
              startMs: 3_000,
              durationMs: 25,
              exit: { _tag: "Interrupted", cause: "Interrupted" },
              events: [
                {
                  name: "status delayed ⏳",
                  timeUnixNano: ns(3_010),
                  attributes: { "effect.logLevel": "Warning" },
                },
              ],
            }),
            "",
            record({
              name: "orchestration.dispatch",
              traceId: "trace-d",
              spanId: "span-d",
              startMs: 4_000,
              durationMs: 250,
              exit: { _tag: "Failure", cause: "Provider crashed: café 🔥" },
            }),
          ].join("\n"),
        ],
      ]);
      const encoder = new TextEncoder();

      const diagnostics = yield* readTraces({
        stream: (path) =>
          Stream.fromIterable(
            Array.from(encoder.encode(files.get(path)), (byte) => Uint8Array.of(byte)),
          ),
      });

      assert.equal(diagnostics.recordCount, 4);
      assert.deepStrictEqual(
        diagnostics,
        aggregateLines([...files.values()].flatMap((text) => text.split(/\r?\n/))),
      );
    }),
  );

  it.effect("preserves full failure causes and log messages", () =>
    Effect.sync(() => {
      const longCause = `VcsProcessSpawnError: ${"missing executable ".repeat(80)}`.trim();
      const longMessage = `provider warning: ${"retrying command ".repeat(80)}`.trim();
      const diagnostics = aggregateLines([
        record({
          name: "VcsProcess.run",
          traceId: "trace-long",
          spanId: "span-long",
          startMs: 1_000,
          durationMs: 25,
          exit: { _tag: "Failure", cause: longCause },
          events: [
            {
              name: longMessage,
              timeUnixNano: ns(1_010),
              attributes: { "effect.logLevel": "Warning" },
            },
          ],
        }),
      ]);

      assert.equal(diagnostics.latestFailures[0]?.cause, longCause);
      assert.equal(diagnostics.commonFailures[0]?.cause, longCause);
      assert.equal(diagnostics.latestWarningAndErrorLogs[0]?.message, longMessage);
    }),
  );

  it.effect("keeps loaded trace data when one rotated trace file fails to read", () =>
    Effect.gen(function* () {
      const readFailure = PlatformError.systemError({
        _tag: "PermissionDenied",
        module: "FileSystem",
        method: "open",
        description: "permission denied",
        pathOrDescriptor: `${traceFilePath}.1`,
      });
      const logAnnotations: Array<Record<string, unknown>> = [];
      const logger = Logger.make<unknown, void>((options) => {
        logAnnotations.push({ ...options.fiber.getRef(References.CurrentLogAnnotations) });
      });

      const diagnostics = yield* readTraces({
        stream: (path) =>
          path === `${traceFilePath}.1`
            ? Stream.fail(readFailure)
            : Stream.make(
                new TextEncoder().encode(
                  record({
                    name: "server.getConfig",
                    traceId: "trace-a",
                    spanId: "span-a",
                    startMs: 1_000,
                    durationMs: 50,
                  }),
                ),
              ),
      }).pipe(Effect.provide(Logger.layer([logger], { mergeWithExisting: false })));

      assert.equal(diagnostics.recordCount, 1);
      assert.equal(
        Option.getOrElse(diagnostics.partialFailure, () => false),
        true,
      );
      assert.deepStrictEqual(Option.getOrUndefined(diagnostics.error), {
        kind: "trace-file-read-failed",
        message: `Failed to read local trace file '${traceFilePath}.1'.`,
      });
      assert.deepStrictEqual(diagnostics.scannedFilePaths, [`${traceFilePath}.1`, traceFilePath]);

      const failureLog = logAnnotations.find(
        (annotations) => annotations.traceFilePath === `${traceFilePath}.1`,
      );
      assert.exists(failureLog);
      assert.deepStrictEqual(failureLog, {
        traceFilePath: `${traceFilePath}.1`,
        errorTag: "TraceFileReadError",
        causeTag: "PermissionDenied",
      });
    }),
  );

  it.effect("keeps only the top spans, failures, and warning logs from large inputs", () =>
    Effect.sync(() => {
      // Shuffled, so some older records arrive after the lists are full.
      const indexes = Array.from({ length: 30 }, (_, step) => (step * 7) % 30);
      const diagnostics = aggregateLines(
        indexes.map((index) =>
          record({
            name: `span-${index}`,
            traceId: `trace-${index}`,
            spanId: `span-${index}`,
            startMs: index * 1_000,
            durationMs: index,
            exit: { _tag: "Failure", cause: "Provider crashed" },
            events: [
              {
                name: `warning ${index}`,
                timeUnixNano: ns(index * 1_000),
                attributes: { "effect.logLevel": "Warning" },
              },
            ],
          }),
        ),
      );
      const newestTwenty = Array.from({ length: 20 }, (_, rank) => `trace-${29 - rank}`);

      assert.equal(diagnostics.recordCount, 30);
      assert.deepStrictEqual(
        diagnostics.slowestSpans.map((span) => span.durationMs),
        [29, 28, 27, 26, 25, 24, 23, 22, 21, 20],
      );
      assert.deepStrictEqual(
        diagnostics.latestFailures.map((failure) => failure.traceId),
        newestTwenty,
      );
      assert.deepStrictEqual(
        diagnostics.latestWarningAndErrorLogs.map((log) => log.traceId),
        newestTwenty,
      );
    }),
  );
});

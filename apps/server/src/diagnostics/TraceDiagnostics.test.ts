import { assert, describe, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PlatformError from "effect/PlatformError";

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

describe("TraceDiagnostics", () => {
  it.effect("aggregates failures, slow spans, log levels, and parse errors", () =>
    Effect.sync(() => {
      const diagnostics = TraceDiagnostics.aggregateTraceDiagnostics({
        traceFilePath: "/tmp/server.trace.ndjson",
        readAt: DateTime.makeUnsafe("2026-05-05T10:00:00.000Z"),
        slowSpanThresholdMs: 1_000,
        files: [
          {
            path: "/tmp/server.trace.ndjson.1",
            text: [
              record({
                name: "server.getConfig",
                traceId: "trace-a",
                spanId: "span-a",
                startMs: 1_000,
                durationMs: 50,
              }),
              "not-json",
            ].join("\n"),
          },
          {
            path: "/tmp/server.trace.ndjson",
            text: [
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
            ].join("\n"),
          },
        ],
      });

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
    Effect.sync(() => {
      const diagnostics = TraceDiagnostics.aggregateTraceDiagnostics({
        traceFilePath: "/tmp/missing.trace.ndjson",
        readAt: DateTime.makeUnsafe("2026-05-05T10:00:00.000Z"),
        files: [],
      });

      assert.equal(diagnostics.recordCount, 0);
      assert.equal(Option.getOrUndefined(diagnostics.error)?.kind, "trace-file-not-found");
    }),
  );

  it.effect("preserves full failure causes and log messages", () =>
    Effect.sync(() => {
      const longCause = `VcsProcessSpawnError: ${"missing executable ".repeat(80)}`.trim();
      const longMessage = `provider warning: ${"retrying command ".repeat(80)}`.trim();
      const diagnostics = TraceDiagnostics.aggregateTraceDiagnostics({
        traceFilePath: "/tmp/server.trace.ndjson",
        readAt: DateTime.makeUnsafe("2026-05-05T10:00:00.000Z"),
        files: [
          {
            path: "/tmp/server.trace.ndjson",
            text: record({
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
          },
        ],
      });

      assert.equal(diagnostics.latestFailures[0]?.cause, longCause);
      assert.equal(diagnostics.commonFailures[0]?.cause, longCause);
      assert.equal(diagnostics.latestWarningAndErrorLogs[0]?.message, longMessage);
    }),
  );

  it.effect("keeps loaded trace data when one rotated trace file fails to read", () =>
    Effect.gen(function* () {
      const traceFilePath = "/tmp/server.trace.ndjson";
      const fileSystemLayer = FileSystem.layerNoop({
        readFileString: (path) =>
          path === `${traceFilePath}.1`
            ? Effect.fail(
                PlatformError.systemError({
                  _tag: "PermissionDenied",
                  module: "FileSystem",
                  method: "readFileString",
                  description: "permission denied",
                  pathOrDescriptor: path,
                }),
              )
            : Effect.succeed(
                record({
                  name: "server.getConfig",
                  traceId: "trace-a",
                  spanId: "span-a",
                  startMs: 1_000,
                  durationMs: 50,
                }),
              ),
      });

      const diagnostics = yield* TraceDiagnostics.readTraceDiagnostics({
        traceFilePath,
        maxFiles: 1,
        readAt: DateTime.makeUnsafe("2026-05-05T10:00:00.000Z"),
      }).pipe(Effect.provide(TraceDiagnostics.layer.pipe(Layer.provide(fileSystemLayer))));

      assert.equal(diagnostics.recordCount, 1);
      assert.equal(
        Option.getOrElse(diagnostics.partialFailure, () => false),
        true,
      );
      assert.equal(Option.getOrUndefined(diagnostics.error)?.kind, "trace-file-read-failed");
      assert.deepStrictEqual(diagnostics.scannedFilePaths, [`${traceFilePath}.1`, traceFilePath]);
    }),
  );

  it.effect("keeps only the slowest span occurrences while aggregating large inputs", () =>
    Effect.sync(() => {
      const diagnostics = TraceDiagnostics.aggregateTraceDiagnostics({
        traceFilePath: "/tmp/server.trace.ndjson",
        readAt: DateTime.makeUnsafe("2026-05-05T10:00:00.000Z"),
        files: [
          {
            path: "/tmp/server.trace.ndjson",
            text: Array.from({ length: 25 }, (_, index) =>
              record({
                name: `span-${index}`,
                traceId: `trace-${index}`,
                spanId: `span-${index}`,
                startMs: index * 1_000,
                durationMs: index,
              }),
            ).join("\n"),
          },
        ],
      });

      assert.equal(diagnostics.recordCount, 25);
      assert.equal(diagnostics.slowestSpans.length, 10);
      assert.deepStrictEqual(
        diagnostics.slowestSpans.map((span) => span.durationMs),
        [24, 23, 22, 21, 20, 19, 18, 17, 16, 15],
      );
    }),
  );
});

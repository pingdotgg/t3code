import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as TestConsole from "effect/testing/TestConsole";
import { Command } from "effect/cli";

import { formatTraceSummary, makeTraceSpanSummary, traceCommand } from "./trace.ts";

const MINUTE_MS = 60_000;

function span(name: string, durationMs: number, endMs: number, exitTag = "Success") {
  return JSON.stringify({
    type: "effect-span",
    name,
    traceId: "trace",
    spanId: "span",
    durationMs,
    endTimeUnixNano: String(BigInt(endMs) * 1_000_000n),
    exit: { _tag: exitTag, cause: "cause" },
  });
}

function browserSpan(
  name: string,
  status: { code: string; message?: string },
  attributes: Record<string, unknown> = {},
) {
  return JSON.stringify({
    type: "otlp-span",
    name,
    durationMs: 1,
    endTimeUnixNano: "1000000",
    status,
    attributes,
  });
}

const traceSummaryFixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const baseDir = yield* fs.makeTempDirectoryScoped();
  const traceFilePath = path.join(baseDir, "trace.ndjson");
  const rotatedPath = `${traceFilePath}.1`;
  yield* fs.makeDirectory(rotatedPath);

  const run = Command.runWith(traceCommand, { version: "0.0.0" })([
    "summary",
    "--base-dir",
    baseDir,
  ]).pipe(
    Effect.provide(
      ConfigProvider.layer(
        ConfigProvider.fromEnv({
          env: { T3CODE_TRACE_FILE: traceFilePath, T3CODE_TRACE_MAX_FILES: "2" },
        }),
      ),
    ),
  );
  return { fs, traceFilePath, rotatedPath, run };
});

it.effect("summarizes the current trace when a rotated file cannot be read", () =>
  Effect.gen(function* () {
    const { fs, traceFilePath, rotatedPath, run } = yield* traceSummaryFixture;
    yield* fs.writeFileString(traceFilePath, `${span("sample.span", 5, MINUTE_MS)}\n`);

    yield* run;

    assert.include((yield* TestConsole.logLines).join("\n"), "sample.span");
    assert.deepStrictEqual(yield* TestConsole.errorLines, [
      `Failed to read local trace file '${rotatedPath}'.`,
    ]);
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("reports a read error when no trace files can be read", () =>
  Effect.gen(function* () {
    const { rotatedPath, run } = yield* traceSummaryFixture;

    const error = yield* Effect.flip(run);

    assert.propertyVal(error, "message", `Failed to read local trace file '${rotatedPath}'.`);
    assert.isEmpty(yield* TestConsole.logLines);
  }).pipe(Effect.provide(NodeServices.layer)),
);

it("drops spans that ended before the window and counts unreadable lines", () => {
  const nowMs = Date.UTC(2026, 10, 24);
  const cutoff = BigInt(nowMs) * 1_000_000n - 1n;
  const summarizer = makeTraceSpanSummary({ nowMs, duration: Duration.nanos(1n) });
  [
    span("old", 1, 0),
    JSON.stringify({
      name: "just-before",
      durationMs: 1,
      endTimeUnixNano: String(cutoff - 1n),
    }),
    "",
    "{not json",
    JSON.stringify({ name: "no-duration" }),
    JSON.stringify({ name: "far-future", durationMs: 1, endTimeUnixNano: "9".repeat(22) }),
    JSON.stringify({ name: "at-cutoff", durationMs: 4, endTimeUnixNano: String(cutoff) }),
  ].forEach(summarizer.addLine);
  const summary = summarizer.finish();

  assert.strictEqual(summary.skippedLineCount, 3);
  assert.deepStrictEqual(
    summary.spans.map((entry) => [entry.name, entry.count, entry.perMinute]),
    [["at-cutoff", 1, undefined]],
  );
});

it("reads failures and interrupts of browser spans from their OTLP status", () => {
  const summarizer = makeTraceSpanSummary();
  [
    browserSpan("render", { code: "2", message: "Interrupted" }),
    browserSpan("render", { code: "0" }, { "effect.fiber.interrupted": true }),
    browserSpan("render", { code: "1", message: "Interrupted" }),
    browserSpan("render", { code: "1" }),
  ].forEach(summarizer.addLine);

  const [render] = summarizer.finish().spans;
  assert.deepStrictEqual([render?.count, render?.interrupted, render?.failures], [4, 2, 1]);
});

it("prints durations that round up to a second in seconds", () => {
  const summarizer = makeTraceSpanSummary();
  [span("rpc", 999.4, MINUTE_MS), span("rpc", 999.6, 2 * MINUTE_MS)].forEach(summarizer.addLine);

  const row = formatTraceSummary(summarizer.finish(), 25)
    .split("\n")
    .find((line) => line.startsWith("rpc"));
  assert.deepStrictEqual(row?.trim().split(/\s+/).slice(3, 6), ["999ms", "1s", "1s"]);
});

it("keeps sub-millisecond windows and rates without rounding printed dates", () => {
  const summarizer = makeTraceSpanSummary({
    nowMs: 1_795_478_400_000,
    duration: Duration.millis(1.75),
  });
  ["1795478399998000000", "1795478399998999950", "1795478399999999999"]
    .map((endTimeUnixNano) => JSON.stringify({ name: "rpc", durationMs: 1, endTimeUnixNano }))
    .forEach(summarizer.addLine);
  const summary = summarizer.finish();
  const formatted = formatTraceSummary(summary, 25);
  const row = formatted.split("\n").find((line) => line.startsWith("rpc"));

  assert.strictEqual(summary.spanCount, 2);
  assert.strictEqual(row?.trim().split(/\s+/)[2], "120000.0");
  assert.include(formatted, "from 2026-11-23T23:59:59.998Z to 2026-11-23T23:59:59.999Z");
});

it("includes an end time in scientific notation at the window boundary", () => {
  const summarizer = makeTraceSpanSummary({ nowMs: 1_795_478_400_001, duration: Duration.zero });
  summarizer.addLine(
    JSON.stringify({ name: "rpc", durationMs: 1, endTimeUnixNano: "1795478400001e6" }),
  );

  assert.include(formatTraceSummary(summarizer.finish(), 25), "to 2026-11-24T00:00:00.001Z");
});

it("formats large summaries without overflowing the call stack", () => {
  const rowCount = 150_000;
  const entry = {
    name: "long-span-name",
    count: 1,
    perMinute: 1,
    p50Ms: 1,
    p90Ms: 1,
    maxMs: 1,
    interrupted: 0,
    failures: 0,
  };
  const spans = Array.from({ length: rowCount }, () => entry);

  const lines = formatTraceSummary(
    {
      spanCount: rowCount,
      skippedLineCount: 0,
      firstEndMs: 0,
      lastEndMs: MINUTE_MS,
      minutes: 1,
      spans,
    },
    rowCount,
  ).split("\n");

  assert.strictEqual(lines.length, rowCount + 3);
  assert.strictEqual(lines[2], "span            count  /min  p50  p90  max  interrupted  failed");
  assert.strictEqual(
    lines.at(-1),
    "long-span-name      1   1.0  1ms  1ms  1ms            0       0",
  );
});

it("uses singular nouns only for counts of one", () => {
  const summarize = (lines: ReadonlyArray<string>) => {
    const summarizer = makeTraceSpanSummary();
    lines.forEach(summarizer.addLine);
    return formatTraceSummary(summarizer.finish(), 0).split("\n");
  };
  const one = summarize([span("a", 1, MINUTE_MS), "{not json"]);
  const two = summarize([span("a", 1, MINUTE_MS), span("b", 1, MINUTE_MS), "x", "y"]);

  assert.deepStrictEqual(
    [one[0]?.split(" ended")[0], one[1], one.at(-1)],
    ["1 span", "Skipped 1 line that is not a span.", "1 more span name. Use --limit to show more."],
  );
  assert.deepStrictEqual(
    [two[0]?.split(" ended")[0], two[1], two.at(-1)],
    [
      "2 spans",
      "Skipped 2 lines that are not spans.",
      "2 more span names. Use --limit to show more.",
    ],
  );
});

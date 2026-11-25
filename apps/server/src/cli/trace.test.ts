import { assert, it } from "@effect/vitest";

import { formatTraceSummary, makeTraceSpanSummary } from "./trace.ts";

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

it("drops spans that ended before the window and counts unreadable lines", () => {
  const summarizer = makeTraceSpanSummary(MINUTE_MS);
  [
    span("old", 1, 0),
    "",
    "{not json",
    JSON.stringify({ name: "no-duration" }),
    JSON.stringify({ name: "far-future", durationMs: 1, endTimeUnixNano: "9".repeat(22) }),
    span("recent", 4, 5 * MINUTE_MS),
  ].forEach(summarizer.addLine);
  const summary = summarizer.finish();

  assert.strictEqual(summary.skippedLineCount, 3);
  assert.deepStrictEqual(
    summary.spans.map((entry) => [entry.name, entry.count, entry.perMinute]),
    [["recent", 1, undefined]],
  );
});

it("reads failures and interrupts of browser spans from their OTLP status", () => {
  const summarizer = makeTraceSpanSummary();
  [
    browserSpan("render", { code: "2", message: "boom" }),
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
  const summarizer = makeTraceSpanSummary(1_795_478_399_998.25);
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

it("prints end times in other numeric spellings as before", () => {
  const summarizer = makeTraceSpanSummary();
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

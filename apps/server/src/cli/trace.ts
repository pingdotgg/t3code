import { PositiveInt } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Config from "effect/Config";
import * as Console from "effect/Console";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { Command, Flag } from "effect/cli";

import * as ServerConfig from "../config.ts";
import { streamTraceFileLines, toRotatedTracePaths } from "../diagnostics/TraceDiagnostics.ts";
import { resolveBaseDir } from "../os-jank.ts";
import { baseDirFlag, DurationFromString, traceFileConfig, traceMaxFilesConfig } from "./config.ts";

const decodeTraceSpanLine = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      name: Schema.String,
      durationMs: Schema.Finite,
      endTimeUnixNano: Schema.Union([Schema.BigIntFromString, Schema.FiniteFromString]),
      exit: Schema.optional(Schema.Struct({ _tag: Schema.String })),
      // OTLP errors use code 2; interrupts carry effect.fiber.interrupted, or code 1 with Interrupted before Effect 4.0.2.
      status: Schema.optional(
        Schema.Struct({
          code: Schema.optional(Schema.String),
          message: Schema.optional(Schema.String),
        }),
      ),
      attributes: Schema.optional(
        Schema.Struct({ "effect.fiber.interrupted": Schema.optional(Schema.Unknown) }),
      ),
    }),
  ),
);

export function makeTraceSpanSummary(window?: { nowMs: number; duration: Duration.Duration }) {
  const sinceMs = window ? window.nowMs - Duration.toMillis(window.duration) : -Infinity;
  const sinceNanos =
    window && Duration.isFinite(window.duration)
      ? BigInt(window.nowMs) * 1_000_000n - Duration.toNanosUnsafe(window.duration)
      : undefined;
  const byName = new Map<string, { durations: number[]; interrupted: number; failures: number }>();
  let spanCount = 0;
  let skippedLineCount = 0;
  let firstEndMs = Infinity;
  let lastEndMs = -Infinity;
  let firstPrintedMs = Infinity;
  let lastPrintedMs = -Infinity;

  const addLine = (line: string) => {
    if (line.trim().length === 0) return;
    const span = Option.getOrUndefined(decodeTraceSpanLine(line));
    if (span === undefined) {
      skippedLineCount += 1;
      return;
    }
    const endMs = Number(span.endTimeUnixNano) / 1_000_000;
    // The report prints end times as dates, so skip ones outside the Date range.
    if (Option.isNone(DateTime.make(endMs))) {
      skippedLineCount += 1;
      return;
    }
    const beforeWindow =
      sinceNanos !== undefined && typeof span.endTimeUnixNano === "bigint"
        ? span.endTimeUnixNano < sinceNanos
        : endMs < sinceMs;
    if (beforeWindow) return;

    spanCount += 1;
    firstEndMs = Math.min(firstEndMs, endMs);
    lastEndMs = Math.max(lastEndMs, endMs);
    // Printed dates use the exact value while float bounds feed the rate.
    const printedMs =
      typeof span.endTimeUnixNano === "bigint" ? Number(span.endTimeUnixNano / 1_000_000n) : endMs;
    firstPrintedMs = Math.min(firstPrintedMs, printedMs);
    lastPrintedMs = Math.max(lastPrintedMs, printedMs);
    const stats = byName.get(span.name) ?? { durations: [], interrupted: 0, failures: 0 };
    stats.durations.push(span.durationMs);
    if (
      span.exit?._tag === "Interrupted" ||
      span.attributes?.["effect.fiber.interrupted"] === true ||
      span.status?.message === "Interrupted"
    ) {
      stats.interrupted += 1;
    }
    if (span.exit?._tag === "Failure" || span.status?.code === "2") stats.failures += 1;
    byName.set(span.name, stats);
  };

  const finish = () => {
    const minutes = (lastEndMs - firstEndMs) / 60_000;
    const spans = [...byName]
      .map(([name, { durations, interrupted, failures }]) => {
        const sorted = durations.toSorted((left, right) => left - right);
        const percentile = (p: number) => sorted[Math.ceil(p * sorted.length) - 1]!;
        return {
          name,
          count: sorted.length,
          perMinute: minutes > 0 ? sorted.length / minutes : undefined,
          p50Ms: percentile(0.5),
          p90Ms: percentile(0.9),
          maxMs: sorted[sorted.length - 1]!,
          interrupted,
          failures,
        };
      })
      .toSorted((left, right) => right.count - left.count || left.name.localeCompare(right.name));

    return {
      spanCount,
      skippedLineCount,
      firstEndMs: firstPrintedMs,
      lastEndMs: lastPrintedMs,
      minutes,
      spans,
    };
  };

  return { addLine, finish };
}

const formatSkippedLines = (count: number) =>
  count === 1 ? "Skipped 1 line that is not a span." : `Skipped ${count} lines that are not spans.`;

const formatMs = (ms: number) =>
  Math.round(ms) < 1_000 ? `${Math.round(ms)}ms` : `${Math.round(ms / 100) / 10}s`;

export function formatTraceSummary(
  summary: ReturnType<ReturnType<typeof makeTraceSpanSummary>["finish"]>,
  limit: number,
) {
  const header = ["span", "count", "/min", "p50", "p90", "max", "interrupted", "failed"];
  const rows = summary.spans
    .slice(0, limit)
    .map((span) => [
      span.name,
      String(span.count),
      span.perMinute === undefined
        ? "-"
        : span.perMinute < 0.1
          ? "<0.1"
          : span.perMinute.toFixed(1),
      formatMs(span.p50Ms),
      formatMs(span.p90Ms),
      formatMs(span.maxMs),
      String(span.interrupted),
      String(span.failures),
    ]);
  const table = [header, ...rows];
  const widths = header.map((_, column) =>
    table.reduce((max, row) => Math.max(max, row[column]!.length), 0),
  );
  const formatIso = (ms: number) => DateTime.formatIso(DateTime.makeUnsafe(ms));
  const hiddenCount = summary.spans.length - limit;
  return [
    `${summary.spanCount} ${summary.spanCount === 1 ? "span" : "spans"} ended from ${formatIso(summary.firstEndMs)} to ${formatIso(summary.lastEndMs)} (${summary.minutes.toFixed(1).replace(/\.0+$/, "")} min).`,
    ...(summary.skippedLineCount > 0 ? [formatSkippedLines(summary.skippedLineCount)] : []),
    "",
    ...table.map((row) =>
      row
        .map((cell, column) =>
          column === 0 ? cell.padEnd(widths[column]!) : cell.padStart(widths[column]!),
        )
        .join("  "),
    ),
    ...(hiddenCount > 0
      ? [
          "",
          `${hiddenCount} more ${hiddenCount === 1 ? "span name" : "span names"}. Use --limit to show more.`,
        ]
      : []),
  ].join("\n");
}

const traceSummaryCommand = Command.make("summary", {
  baseDir: baseDirFlag,
  since: Flag.String("since").pipe(
    Flag.withSchema(DurationFromString),
    Flag.withDescription("Only count spans that ended in this window, for example 30m or 2h."),
    Flag.optional,
  ),
  limit: Flag.Int("limit").pipe(
    Flag.withSchema(PositiveInt),
    Flag.withDescription("Number of span names to show, busiest first."),
    Flag.withDefault(25),
  ),
}).pipe(
  Command.withDescription("Summarize the local server trace file: counts, rates, and latency."),
  Command.withHandler(
    Effect.fn("cli.trace.summary")(function* (flags) {
      const fs = yield* FileSystem.FileSystem;
      const envHome = yield* Config.String("T3CODE_HOME").pipe(Config.option);
      const baseDir = yield* resolveBaseDir(
        Option.getOrUndefined(Option.orElse(flags.baseDir, () => envHome)),
      );
      const traceFilePath =
        (yield* traceFileConfig) ??
        (yield* ServerConfig.deriveServerPaths(baseDir, undefined)).serverTracePath;
      const window = Option.isSome(flags.since)
        ? { nowMs: yield* Clock.currentTimeMillis, duration: flags.since.value }
        : undefined;
      const summarizer = makeTraceSpanSummary(window);
      yield* Effect.forEach(
        toRotatedTracePaths(traceFilePath, yield* traceMaxFilesConfig),
        (path) => streamTraceFileLines(fs, path, summarizer.addLine),
        { discard: true },
      );
      const summary = summarizer.finish();

      yield* Console.log(
        summary.spanCount === 0
          ? `No spans found in ${traceFilePath} or its rotated files${window === undefined ? "" : " in that window"}.${summary.skippedLineCount > 0 ? ` ${formatSkippedLines(summary.skippedLineCount)}` : ""}`
          : formatTraceSummary(summary, flags.limit),
      );
    }),
  ),
);

export const traceCommand = Command.make("trace").pipe(
  Command.withDescription("Inspect the local server trace file."),
  Command.withSubcommands([traceSummaryCommand]),
);

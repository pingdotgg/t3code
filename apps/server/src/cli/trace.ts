/**
 * `t3 trace summary` - per-span counts, rates, and latency percentiles from
 * the local server trace file and its rotated backups. It reads the files
 * directly, so it works while the server is stalled or stopped.
 */
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
import * as Stream from "effect/Stream";
import { Command, Flag } from "effect/unstable/cli";

import * as ServerConfig from "../config.ts";
import { toRotatedTracePaths, TraceFileReadError } from "../diagnostics/TraceDiagnostics.ts";
import { resolveBaseDir } from "../os-jank.ts";
import { baseDirFlag, DurationFromString, traceFileConfig, traceMaxFilesConfig } from "./config.ts";

// Only the fields the summary needs. Other record fields are ignored.
const decodeTraceSpanLine = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      name: Schema.String,
      durationMs: Schema.Finite,
      endTimeUnixNano: Schema.FiniteFromString,
      // Server (`effect-span`) records.
      exit: Schema.optional(Schema.Struct({ _tag: Schema.String })),
      // Browser (`otlp-span`) records. Effect's OTLP tracer writes code "2" for
      // errors and code "1" with message "Interrupted" for interrupts.
      status: Schema.optional(
        Schema.Struct({
          code: Schema.optional(Schema.String),
          message: Schema.optional(Schema.String),
        }),
      ),
    }),
  ),
);

/**
 * Groups trace NDJSON by span name. Call `addLine` once per line as the files
 * stream in, then `finish` for the summary. Spans that ended before `sinceMs`
 * are left out. Rates are per minute between the first and last span end,
 * since spans are written when they end.
 */
export function makeTraceSpanSummary(sinceMs = -Infinity) {
  // Keep each span's duration (8 bytes, a few MB for the default 110 MB of
  // rotated traces) for exact percentiles. A bounded sketch would save little
  // and make p50 and p90 approximate.
  const byName = new Map<string, { durations: number[]; interrupted: number; failures: number }>();
  let spanCount = 0;
  let skippedLineCount = 0;
  let firstEndMs = Infinity;
  let lastEndMs = -Infinity;

  const addLine = (line: string) => {
    if (line.trim().length === 0) return;
    const span = Option.getOrUndefined(decodeTraceSpanLine(line));
    if (span === undefined) {
      skippedLineCount += 1;
      return;
    }
    const endMs = span.endTimeUnixNano / 1_000_000;
    // The report prints end times as dates, so skip ones outside the Date range.
    if (Option.isNone(DateTime.make(endMs))) {
      skippedLineCount += 1;
      return;
    }
    if (endMs < sinceMs) return;

    spanCount += 1;
    firstEndMs = Math.min(firstEndMs, endMs);
    lastEndMs = Math.max(lastEndMs, endMs);
    const stats = byName.get(span.name) ?? { durations: [], interrupted: 0, failures: 0 };
    stats.durations.push(span.durationMs);
    if (span.exit?._tag === "Interrupted" || span.status?.message === "Interrupted") {
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
        // Nearest-rank percentile.
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

    return { spanCount, skippedLineCount, firstEndMs, lastEndMs, minutes, spans };
  };

  return { addLine, finish };
}

const formatMs = (ms: number) =>
  ms < 1_000 ? `${Math.round(ms)}ms` : `${(ms / 1_000).toFixed(1)}s`;

function formatTraceSummary(
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
  const widths = header.map((_, column) => Math.max(...table.map((row) => row[column]!.length)));
  const formatIso = (ms: number) => DateTime.formatIso(DateTime.makeUnsafe(ms));
  return [
    `${summary.spanCount} spans ended from ${formatIso(summary.firstEndMs)} to ${formatIso(summary.lastEndMs)} (${summary.minutes.toFixed(1)} min).`,
    ...(summary.skippedLineCount > 0
      ? [`Skipped ${summary.skippedLineCount} lines that are not spans.`]
      : []),
    "",
    ...table.map((row) =>
      row
        .map((cell, column) =>
          column === 0 ? cell.padEnd(widths[column]!) : cell.padStart(widths[column]!),
        )
        .join("  "),
    ),
    ...(summary.spans.length > limit
      ? ["", `${summary.spans.length - limit} more span names. Use --limit to show more.`]
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
      // T3CODE_TRACE_FILE, else the userdata trace file for --base-dir or
      // T3CODE_HOME. Implicit dev runs write elsewhere; set T3CODE_TRACE_FILE.
      const envHome = yield* Config.String("T3CODE_HOME").pipe(Config.option);
      const baseDir = yield* resolveBaseDir(
        Option.getOrUndefined(Option.orElse(flags.baseDir, () => envHome)),
      );
      const traceFilePath =
        (yield* traceFileConfig) ??
        (yield* ServerConfig.deriveServerPaths(baseDir, undefined)).serverTracePath;
      const sinceMs = Option.isSome(flags.since)
        ? (yield* Clock.currentTimeMillis) - Duration.toMillis(flags.since.value)
        : undefined;
      const summarizer = makeTraceSpanSummary(sinceMs);
      // Stream each file so only one chunk of text is in memory at a time.
      yield* Effect.forEach(
        toRotatedTracePaths(traceFilePath, yield* traceMaxFilesConfig),
        (path) =>
          fs.stream(path).pipe(
            Stream.decodeText,
            Stream.splitLines,
            Stream.runForEachArray((lines) => Effect.sync(() => lines.forEach(summarizer.addLine))),
            Effect.catchTags({
              PlatformError: (cause) =>
                cause.reason._tag === "NotFound"
                  ? Effect.void
                  : Effect.fail(
                      new TraceFileReadError({
                        traceFilePath: path,
                        causeTag: cause.reason._tag,
                        cause,
                      }),
                    ),
            }),
          ),
        { discard: true },
      );
      const summary = summarizer.finish();

      yield* Console.log(
        summary.spanCount === 0
          ? `No spans found in ${traceFilePath} or its rotated files${sinceMs === undefined ? "" : " in that window"}.${summary.skippedLineCount > 0 ? ` Skipped ${summary.skippedLineCount} lines that are not spans.` : ""}`
          : formatTraceSummary(summary, flags.limit),
      );
    }),
  ),
);

export const traceCommand = Command.make("trace").pipe(
  Command.withDescription("Inspect the local server trace file."),
  Command.withSubcommands([traceSummaryCommand]),
);

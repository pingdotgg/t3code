/**
 * Persistent run log: every test's pass/failure followed by its captured
 * output, appended to `.alchemy/log/test.log` as the run progresses —
 * color-free so agents and tooling can read it directly.
 */
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";

import type { LogEntry } from "./Model.ts";
import type { TestEvent } from "./Reporter.ts";

const formatDuration = (ms: number): string =>
  ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`;

const formatLogs = (logs: ReadonlyArray<LogEntry>): string =>
  logs.map((log) => log.message).join("\n");

const GLYPH = {
  pass: "PASS",
  fail: "FAIL",
  skip: "SKIP",
  todo: "TODO",
} as const;

/** Render an event as a log chunk; `undefined` = nothing to write. */
export const formatEvent = (event: TestEvent): string | undefined => {
  switch (event._tag) {
    case "RunStart":
      return `running ${event.tests.length} tests from ${event.files} files (${new Date().toISOString()})\n\n`;
    case "TestEnd": {
      const title = `${event.test.file} > ${event.test.titlePath.join(" > ")}`;
      const retries =
        event.result.retries > 0 ? ` [retried x${event.result.retries}]` : "";
      const lines = [
        `${GLYPH[event.result.status]} ${title} (${formatDuration(event.result.durationMs)})${retries}`,
      ];
      if (event.result.error !== undefined) {
        lines.push(event.result.error);
      }
      if (event.result.logs.length > 0) {
        lines.push("--- captured output ---");
        lines.push(formatLogs(event.result.logs));
        lines.push("--- end output ---");
      }
      // One line per plain result; a blank separator only after multi-line
      // entries (error/output blocks) so they don't run into the next entry.
      return lines.length === 1 ? `${lines[0]}\n` : `${lines.join("\n")}\n\n`;
    }
    case "FileEnd": {
      const lines: Array<string> = [];
      if (event.error !== undefined) {
        lines.push(`FAIL ${event.file} failed to run`, event.error);
      }
      if (event.logs.length > 0) {
        lines.push(`--- file hook output (${event.file}) ---`);
        lines.push(formatLogs(event.logs));
        lines.push("--- end output ---");
      }
      return lines.length === 0 ? undefined : `${lines.join("\n")}\n\n`;
    }
    case "RunEnd": {
      const s = event.summary;
      return (
        `Tests: ${s.failed} failed | ${s.passed} passed` +
        (s.skipped > 0 ? ` | ${s.skipped} skipped` : "") +
        (s.todo > 0 ? ` | ${s.todo} todo` : "") +
        ` (${s.files} files, ${formatDuration(s.durationMs)})\n`
      );
    }
    default:
      return undefined;
  }
};

export interface FileLog {
  readonly append: (event: TestEvent) => Effect.Effect<void>;
  /**
   * Enqueue one live file-hook log line (prefixed with the file it belongs
   * to). File-level hooks (beforeAll deploys / afterAll destroys) can run
   * for many minutes; buffering their output until `FileEnd` makes the run
   * log go silent for the whole time — a long-running deploy then reads as
   * a deadlocked run. Streaming each entry as it is captured keeps the log
   * tail-able mid-hook.
   *
   * This performs NO I/O: it only offers the formatted line to an
   * unbounded queue drained by a background writer fiber (all file I/O is
   * Effect-based and async). It is therefore safe to call from the
   * synchronous array-push interception that captures hook output.
   */
  readonly appendHookLine: (file: string, entry: LogEntry) => void;
  /**
   * Gracefully end the hook-line stream: signals the queue, lets the
   * writer fiber drain every enqueued line to disk, and awaits it. Call
   * once at the end of the run so no tail lines are lost.
   */
  readonly close: Effect.Effect<void>;
}

const LOG_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Delete sibling run logs whose mtime (from stat — file names are never
 * trusted) is older than a week, so the per-run log directory can't grow
 * unboundedly. Best-effort: failures are ignored.
 */
const pruneOldLogs = Effect.fn(function* (dir: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const entries = yield* fs
    .readDirectory(dir)
    .pipe(Effect.orElseSucceed(() => [] as Array<string>));
  const cutoff = Date.now() - LOG_RETENTION_MS;
  for (const entry of entries) {
    if (!entry.endsWith(".log")) continue;
    const file = path.join(dir, entry);
    const info = yield* fs
      .stat(file)
      .pipe(Effect.orElseSucceed(() => undefined));
    const mtime =
      info === undefined ? undefined : Option.getOrUndefined(info.mtime);
    if (mtime !== undefined && mtime.getTime() < cutoff) {
      yield* fs.remove(file).pipe(Effect.ignore);
    }
  }
});

/** Create (truncate) the log file and return an event appender. */
export const makeFileLog = Effect.fn(function* (logFile: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fs
    .makeDirectory(path.dirname(logFile), { recursive: true })
    .pipe(Effect.ignore);
  yield* pruneOldLogs(path.dirname(logFile));
  yield* fs.writeFileString(logFile, "").pipe(Effect.ignore);
  const append: FileLog["append"] = (event) => {
    const chunk = formatEvent(event);
    if (chunk === undefined) return Effect.void;
    return fs
      .writeFileString(logFile, chunk, { flag: "a" })
      .pipe(Effect.ignore);
  };
  // Hook lines flow through an unbounded queue to a single writer fiber so
  // the capture site (a synchronous array-push interception) never performs
  // I/O and never blocks: `offerUnsafe` on an unbounded queue is a plain
  // in-memory enqueue. The writer serializes appends, so hook lines cannot
  // interleave mid-line with the Effect-based `append` writes.
  const hookLines = yield* Queue.make<string, Cause.Done>();
  const writer = yield* Effect.forkChild(
    Effect.gen(function* () {
      while (true) {
        const line = yield* Queue.take(hookLines);
        yield* fs
          .writeFileString(logFile, `${line}\n`, { flag: "a" })
          .pipe(Effect.ignore);
      }
    }).pipe(
      // `Queue.take` fails with `Done` once `close` ends the queue and the
      // backlog is drained — that is the writer's normal exit.
      Effect.catchCause(() => Effect.void),
    ),
  );
  const appendHookLine: FileLog["appendHookLine"] = (file, entry) => {
    const prefixed = entry.message
      .split("\n")
      .map((line) => `[hook ${file}] ${line}`)
      .join("\n");
    Queue.offerUnsafe(hookLines, prefixed);
  };
  const close: FileLog["close"] = Effect.gen(function* () {
    yield* Queue.end(hookLines);
    yield* Fiber.await(writer);
  });
  return { append, appendHookLine, close } satisfies FileLog;
});

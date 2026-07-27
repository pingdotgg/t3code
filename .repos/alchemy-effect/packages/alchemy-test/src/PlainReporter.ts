/**
 * Line-oriented reporter for non-interactive terminals and CI.
 *
 * Reports progress through the collection phase (importing a large suite's
 * files takes tens of seconds before any test can run), then logs one line per
 * test as it finishes, prefixed with a `[done/total]` counter (failures include
 * their error and captured output inline); if nothing finishes for 10s it
 * prints the list of currently-running tests; at the end every failure is
 * repeated consolidated.
 */
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import type { LogEntry } from "./Model.ts";
import {
  Reporter,
  type RunSummary,
  type TestEvent,
  type TestResult,
} from "./Reporter.ts";
import { writeDirect } from "./StrayOutput.ts";

const isTty = process.stdout.isTTY === true;

const useColor = isTty && process.env.NO_COLOR === undefined;

const paint = (code: string) => (text: string) =>
  useColor ? `\u001B[${code}m${text}\u001B[0m` : text;

const red = paint("31");
const green = paint("32");
const yellow = paint("33");
const dim = paint("2");
const bold = paint("1");

const formatDuration = (ms: number): string =>
  ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`;

// Through the REAL stream — while a run is active, bare process.stdout is
// diverted into the run log (see StrayOutput.ts).
const write = (line: string): Effect.Effect<void> =>
  Effect.sync(() => {
    writeDirect(`${line}\n`);
  });

// Captured output is replayed verbatim — no timestamp/level prefixes, no
// indentation. It should read exactly as it would have on a normal terminal.
const formatLogs = (logs: ReadonlyArray<LogEntry>): string =>
  logs.map((log) => log.message).join("\n");

const indent = (text: string, prefix = "  "): string =>
  text
    .split("\n")
    .map((line) => `${prefix}${line}`)
    .join("\n");

/** Mutable per-run reporter state. */
interface ReporterState {
  readonly hookLogs: Map<string, ReadonlyArray<LogEntry>>;
  /**
   * Currently-executing work items: tests AND file-level hooks. Hooks must
   * be tracked too — a `beforeAll` deploy can legitimately run for many
   * minutes with no test starting or finishing, and if the stall report
   * only covered tests, such a run would print nothing at all and read as
   * deadlocked.
   */
  readonly running: Map<string, { label: string; startedAt: number }>;
  /** Total tests in the run, known once RunStart arrives. */
  total: number;
  /** Tests that have reported a result so far, and how they went. */
  completed: number;
  passed: number;
  failed: number;
  lastEnd: number;
  /** Running-set fingerprint of the last stall report — dedupes repeats. */
  lastStallKey: string;
  stallTimer: ReturnType<typeof setInterval> | undefined;
  /** Files discovered for the collection phase. */
  collectTotal: number;
  collectDone: number;
  collectStartedAt: number;
  /** Last file whose import finished — the next one is what's importing now. */
  collectCurrent: string;
  lastCollectRender: number;
  /** An un-terminated in-place progress line is on the terminal. */
  collectLinePending: boolean;
  /** True between CollectStart and RunStart. */
  collecting: boolean;
}

/** Redraw cadence of the collection progress line. */
const COLLECT_RENDER_MS = 100;
/** Cadence of collection progress LINES when stdout isn't a terminal. */
const COLLECT_LINE_MS = 5_000;

const clearCollectLine = (state: ReporterState): void => {
  if (!state.collectLinePending) return;
  state.collectLinePending = false;
  writeDirect("\r\u001B[2K");
};

/**
 * Importing every test file takes tens of seconds on a large suite, and it
 * happens before a single test can be reported — without progress the run is
 * indistinguishable from a deadlock. On a TTY this repaints one line in place;
 * otherwise it prints a line every few seconds. Either way the current file is
 * shown, so a genuinely stuck import is identifiable by name.
 *
 * Also called from the reporter's 1s timer, not just on each imported file, so
 * the elapsed time keeps ticking when an import is what's hanging.
 */
const renderCollect = (state: ReporterState, force: boolean): void => {
  const now = Date.now();
  const cadence = isTty ? COLLECT_RENDER_MS : COLLECT_LINE_MS;
  if (!force && now - state.lastCollectRender < cadence) return;
  state.lastCollectRender = now;
  const head = `collecting ${state.collectDone}/${state.collectTotal} test files (${formatDuration(now - state.collectStartedAt)})`;
  // A pty that reports 0 columns (e.g. under `script`) is unknown, not narrow.
  const columns = process.stdout.columns || 120;
  const room = columns - head.length - 2;
  const tail =
    state.collectCurrent !== "" && room > 12
      ? ` ${state.collectCurrent.slice(-room)}`
      : "";
  if (isTty) {
    state.collectLinePending = true;
    writeDirect(`\r\u001B[2K${dim(head + tail)}`);
  } else {
    writeDirect(`${dim(head + tail)}\n`);
  }
};

/** Settle the progress line on the final count so the total cost stays visible. */
const finishCollect = (state: ReporterState): void => {
  state.collecting = false;
  clearCollectLine(state);
  state.collectCurrent = "";
  renderCollect(state, true);
  if (state.collectLinePending) {
    state.collectLinePending = false;
    writeDirect("\n");
  }
};

/**
 * `[ 12/240 ✓10 ✗2]` counter prefixed to every result line: how much of the
 * run is left, and the running pass/fail tally. Every number is right-aligned
 * on the total's width so the columns after it stay aligned, and each tally is
 * only colored once it is non-zero (a red `✗0` reads as a failure at a glance).
 */
const progress = (
  state: ReporterState,
  status: TestResult["status"],
): string => {
  state.completed += 1;
  if (status === "pass") state.passed += 1;
  else if (status === "fail") state.failed += 1;
  const total = Math.max(state.total, state.completed);
  const width = String(total).length;
  const pad = (n: number) => String(n).padStart(width, " ");
  const pass = `✓${pad(state.passed)}`;
  const fail = `✗${pad(state.failed)}`;
  return [
    dim(`[${pad(state.completed)}/${total}`),
    state.passed > 0 ? green(pass) : dim(pass),
    `${state.failed > 0 ? red(fail) : dim(fail)}${dim("]")}`,
  ].join(" ");
};

const STALL_AFTER_MS = 10_000;
const STALL_LIST_MAX = 25;

/**
 * Print the currently-running tests when nothing has finished for a while.
 * Printed AT MOST ONCE per distinct running set: while the exact same tests
 * stay stuck, nothing is re-printed — the timestamp on the report tells the
 * reader how long ago it was taken.
 */
const printStalled = (state: ReporterState): void => {
  if (state.running.size === 0) return;
  if (Date.now() - state.lastEnd < STALL_AFTER_MS) return;
  const key = [...state.running.keys()].sort().join("\n");
  if (key === state.lastStallKey) return;
  state.lastStallKey = key;
  const now = Date.now();
  const timestamp = new Date(now).toTimeString().slice(0, 8);
  const items = [...state.running.values()].sort(
    (a, b) => a.startedAt - b.startedAt,
  );
  const lines = [
    dim(
      `⧗ [${timestamp}] no tests finished in the last 10s — ${items.length} still running:`,
    ),
  ];
  for (const item of items.slice(0, STALL_LIST_MAX)) {
    lines.push(
      dim(`    ${item.label} (${formatDuration(now - item.startedAt)})`),
    );
  }
  if (items.length > STALL_LIST_MAX) {
    lines.push(dim(`    … ${items.length - STALL_LIST_MAX} more`));
  }
  writeDirect(`${lines.join("\n")}\n`);
};

const onEvent = (
  event: TestEvent,
  state: ReporterState,
): Effect.Effect<void> => {
  switch (event._tag) {
    case "CollectStart":
      state.collectTotal = event.files.length;
      state.collectStartedAt = Date.now();
      state.collecting = true;
      return write(dim(`collecting ${event.files.length} test files...`));
    case "FileCollected":
      return Effect.sync(() => {
        state.collectDone += 1;
        state.collectCurrent = event.file;
        renderCollect(state, false);
      });
    case "RunStart":
      state.total = event.tests.length;
      return Effect.sync(() => finishCollect(state)).pipe(
        Effect.andThen(
          write(
            dim(
              `running ${event.tests.length} tests from ${event.files} files\n`,
            ),
          ),
        ),
      );
    case "TestStart":
      return Effect.sync(() => {
        state.running.set(event.test.id, {
          label: `${event.test.file} > ${event.test.titlePath.join(" > ")}`,
          startedAt: Date.now(),
        });
      });
    case "HookStart":
      return Effect.sync(() => {
        state.running.set(`${event.file} :: ${event.hook}`, {
          label: `${event.file} > [${event.hook} hook]`,
          startedAt: Date.now(),
        });
      });
    case "HookEnd":
      return Effect.sync(() => {
        state.running.delete(`${event.file} :: ${event.hook}`);
        state.lastEnd = Date.now();
      });
    case "TestEnd": {
      state.running.delete(event.test.id);
      state.lastEnd = Date.now();
      const title = `${dim(event.test.file)} ${dim(">")} ${event.test.titlePath.join(` ${dim(">")} `)}`;
      const duration = dim(`(${formatDuration(event.result.durationMs)})`);
      const retries =
        event.result.retries > 0
          ? yellow(` [retried x${event.result.retries}]`)
          : "";
      const count = progress(state, event.result.status);
      switch (event.result.status) {
        case "pass":
          return write(`${count} ${green("✓")} ${title} ${duration}${retries}`);
        case "fail": {
          // Show the failure's details immediately so it can be inspected
          // while the run continues (passed tests stay silent). The end-of-run
          // Failures section repeats them consolidated, with file hook logs.
          const lines = [`${count} ${red("✗")} ${title} ${duration}${retries}`];
          if (event.result.error !== undefined) {
            lines.push(indent(red(event.result.error)));
          }
          if (event.result.logs.length > 0) {
            lines.push(dim("--- captured output ---"));
            lines.push(formatLogs(event.result.logs));
            lines.push(dim("--- end output ---"));
          }
          return write(lines.join("\n"));
        }
        case "skip":
          return write(`${count} ${yellow("↓")} ${title} ${dim("[skipped]")}`);
        case "todo":
          // Warning-styled: a todo is unimplemented coverage, not a pass —
          // it must not blend in with the dim noise around it.
          return write(
            `${count} ${yellow(
              `○ ${event.test.file} > ${event.test.titlePath.join(" > ")} ${bold("[todo]")}`,
            )}`,
          );
      }
    }
    case "FileEnd": {
      if (event.logs.length > 0) {
        state.hookLogs.set(event.file, event.logs);
      }
      if (event.error !== undefined) {
        return write(
          `${red("✗")} ${bold(event.file)} ${red("failed to run")}\n${indent(red(event.error))}` +
            (event.logs.length > 0
              ? `\n${dim("--- file hook output (deploy/destroy) ---")}\n${formatLogs(event.logs)}`
              : ""),
        );
      }
      return Effect.void;
    }
    case "RunEnd":
      return printSummary(event.summary, state.hookLogs);
    default:
      return Effect.void;
  }
};

export const printSummary = (
  summary: RunSummary,
  /** Buffered deploy/destroy output per file, printed once per failing file. */
  hookLogs?: ReadonlyMap<string, ReadonlyArray<LogEntry>>,
): Effect.Effect<void> =>
  Effect.gen(function* () {
    if (summary.failures.length > 0) {
      yield* write(`\n${bold(red(`Failures (${summary.failures.length})`))}\n`);
      const hookLogsPrinted = new Set<string>();
      for (const { meta, result } of summary.failures) {
        yield* write(
          `${red("✗")} ${bold(meta.file)} ${dim(">")} ${meta.titlePath.join(` ${dim(">")} `)}`,
        );
        if (result.error !== undefined) {
          yield* write(indent(red(result.error)));
        }
        if (result.logs.length > 0) {
          yield* write(dim("--- captured output ---"));
          yield* write(formatLogs(result.logs));
          yield* write(dim("--- end output ---"));
        }
        const fileHookLogs = hookLogs?.get(meta.file);
        if (
          fileHookLogs !== undefined &&
          fileHookLogs.length > 0 &&
          !hookLogsPrinted.has(meta.file)
        ) {
          hookLogsPrinted.add(meta.file);
          yield* write(dim("--- file hook output (deploy/destroy) ---"));
          yield* write(formatLogs(fileHookLogs));
          yield* write(dim("--- end output ---"));
        }
        yield* write("");
      }
    }
    // A bare list of what failed, immediately above the counts — the failure
    // details above are long enough that the names scroll out of reach, and
    // each line here is exactly what `-t` matches for a re-run.
    const failedNames = [
      ...summary.failures.map(
        ({ meta }) => `${meta.file} > ${meta.titlePath.join(" > ")}`,
      ),
      ...summary.fileFailures.map(({ file }) => `${file} (whole file)`),
    ];
    if (failedNames.length > 0) {
      yield* write(bold(red(`Failed (${failedNames.length})`)));
      for (const name of failedNames) {
        yield* write(`  ${red("✗")} ${name}`);
      }
    }
    const parts = [
      summary.failed > 0 ? red(`${summary.failed} failed`) : green("0 failed"),
      green(`${summary.passed} passed`),
      ...(summary.skipped > 0 ? [yellow(`${summary.skipped} skipped`)] : []),
      ...(summary.todo > 0 ? [yellow(`${summary.todo} todo`)] : []),
    ];
    yield* write(
      `\n${bold("Tests:")} ${parts.join(dim(" | "))} ${dim(`(${summary.files} files, ${formatDuration(summary.durationMs)})`)}`,
    );
  });

export const PlainReporterLive: Layer.Layer<Reporter> = Layer.sync(Reporter)(
  () => {
    const state: ReporterState = {
      hookLogs: new Map(),
      running: new Map(),
      total: 0,
      completed: 0,
      passed: 0,
      failed: 0,
      lastEnd: Date.now(),
      lastStallKey: "",
      stallTimer: undefined,
      collectTotal: 0,
      collectDone: 0,
      collectStartedAt: Date.now(),
      collectCurrent: "",
      lastCollectRender: 0,
      collectLinePending: false,
      collecting: false,
    };
    // Ticks through both phases: repaints the collection line while files are
    // importing, reports stalled tests once the run is executing.
    const tick = (): void => {
      if (state.collecting) renderCollect(state, false);
      else printStalled(state);
    };
    return {
      emit: (event) =>
        Effect.suspend(() => {
          if (
            (event._tag === "CollectStart" || event._tag === "RunStart") &&
            state.stallTimer === undefined
          ) {
            state.stallTimer = setInterval(tick, 1000);
            // Don't hold the process open once the run's fibers finish.
            (state.stallTimer as unknown as { unref?: () => void }).unref?.();
          }
          if (event._tag === "RunEnd" && state.stallTimer !== undefined) {
            clearInterval(state.stallTimer);
            state.stallTimer = undefined;
          }
          return onEvent(event, state);
        }),
      waitForExit: () => Effect.void,
    };
  },
);

/**
 * Single-process test runner.
 *
 * Discovers `*.test.ts` files, imports them one at a time (registration is
 * global), then executes every collected test as an Effect — files run
 * concurrently up to a limit, tests within a file run sequentially unless
 * their suite is `describe.concurrent`. Each test gets a buffering Effect
 * Logger + Console so its output can be shown in isolation.
 */
import * as Cause from "effect/Cause";
import * as ConsoleModule from "effect/Console";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Logger from "effect/Logger";
import * as Path from "effect/Path";
import * as Semaphore from "effect/Semaphore";
import { inspect } from "node:util";
import { pathToFileURL } from "node:url";

import { makeFileLog } from "./FileLog.ts";
import type { FileSuite, Hook, LogEntry, Suite, TestCase } from "./Model.ts";
import { containsOnly, forEachTest, titlePath } from "./Model.ts";
import * as Registry from "./Registry.ts";
import {
  Reporter,
  type RunController,
  type RunSummary,
  type TestEvent,
  type TestMeta,
  type TestResult,
} from "./Reporter.ts";

export interface RunOptions {
  /** Directory the run is rooted at (usually `packages/alchemy`). */
  readonly root: string;
  /**
   * Positional filters. Existing files/directories are used as-is; anything
   * else is a case-insensitive substring filter on test file paths (like
   * vitest's positional filters). Defaults to `test`.
   */
  readonly paths: ReadonlyArray<string>;
  /**
   * `-t` test-name filter, applied to the full title
   * (`file > describe chain > name`).
   */
  readonly filter?: ((fullTitle: string) => boolean) | undefined;
  /** Default per-test timeout in ms. */
  readonly timeout: number;
  /** Times a failing test body is re-run before being reported as failed. */
  readonly retry: number;
  /** Maximum number of files executing concurrently (default unbounded). */
  readonly concurrency: number | "unbounded";
  /** Force sequential execution within every file. */
  readonly sequential: boolean;
  /** Absolute path of the persistent run log (test.log). */
  readonly logFile: string;
}

// ---------------------------------------------------------------------------
// Log capture
// ---------------------------------------------------------------------------

/**
 * Strip ANSI escape sequences (SGR colors, cursor movement, OSC). Captured
 * output is re-rendered by the reporters — embedded escapes corrupt the
 * TUI's cell-based rendering and garble plain output.
 */
const ANSI_RE =
  // eslint-disable-next-line no-control-regex
  /\u001B(?:\[[0-9;?]*[ -/]*[@-~]|\][^\u0007\u001B]*(?:\u0007|\u001B\\)|[@-Z\\-_])/g;

const stripAnsi = (text: string): string => text.replace(ANSI_RE, "");

const formatArg = (value: unknown): string =>
  stripAnsi(
    typeof value === "string"
      ? value
      : inspect(value, { depth: 4, colors: false }),
  );

const formatArgs = (args: ReadonlyArray<unknown>): string =>
  args.map(formatArg).join(" ");

const bufferingConsole = (logs: Array<LogEntry>): ConsoleModule.Console => {
  const push = (level: string, args: ReadonlyArray<unknown>) => {
    logs.push({ level, message: formatArgs(args), time: new Date() });
  };
  const times = new Map<string, number>();
  return {
    assert: (condition, ...args) => {
      if (!condition) push("error", ["Assertion failed:", ...args]);
    },
    clear: () => {},
    count: (label) => push("info", [`count: ${label ?? "default"}`]),
    countReset: () => {},
    debug: (...args) => push("debug", args),
    dir: (item) => push("info", [item]),
    dirxml: (...args) => push("info", args),
    error: (...args) => push("error", args),
    group: (...args) => push("info", args),
    groupCollapsed: (...args) => push("info", args),
    groupEnd: () => {},
    info: (...args) => push("info", args),
    log: (...args) => push("info", args),
    table: (data) => push("info", [data]),
    time: (label) => {
      times.set(label ?? "default", Date.now());
    },
    timeEnd: (label) => {
      const start = times.get(label ?? "default");
      push("info", [
        `${label ?? "default"}: ${start === undefined ? "?" : Date.now() - start}ms`,
      ]);
    },
    timeLog: (label, ...args) => push("info", [label, ...args]),
    trace: (...args) => push("debug", args),
    warn: (...args) => push("warn", args),
  };
};

/** Provide a buffering Logger + Console around an effect. */
const withCapture =
  (logs: Array<LogEntry>) =>
  <A, E>(effect: Effect.Effect<A, E>): Effect.Effect<A, E> =>
    effect.pipe(
      Effect.provide(
        Logger.layer([
          Logger.make((options) => {
            // `Effect.log("a", "b")` delivers the message as an array —
            // unwrap it so buffered output reads exactly like console output
            // instead of `[ 'a', 'b' ]`.
            const parts = Array.isArray(options.message)
              ? options.message
              : [options.message];
            logs.push({
              level: options.logLevel,
              message:
                parts.map(formatArg).join(" ") +
                (options.cause.reasons.length === 0
                  ? ""
                  : `\n${Cause.pretty(options.cause)}`),
              time: options.date,
            });
          }),
        ]),
      ),
      Effect.provideService(ConsoleModule.Console, bufferingConsole(logs)),
    );

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

const isTestFile = (name: string): boolean =>
  name.endsWith(".test.ts") || name.endsWith(".test.tsx");

export const discover = Effect.fn(function* (options: RunOptions) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const files: Array<string> = [];

  const walk: (
    dir: string,
  ) => Effect.Effect<void, unknown, FileSystem.FileSystem> = Effect.fn(
    function* (dir: string) {
      const entries = yield* fs.readDirectory(dir);
      entries.sort();
      for (const entry of entries) {
        if (entry === "node_modules" || entry.startsWith(".")) continue;
        const full = path.join(dir, entry);
        const stat = yield* fs.stat(full);
        if (stat.type === "Directory") {
          yield* walk(full);
        } else if (isTestFile(entry)) {
          files.push(full);
        }
      }
    },
  );

  // Positional args that exist on disk are roots; anything else is a
  // case-insensitive substring filter on discovered file paths (vitest-style:
  // `alchemy-test Bucket` runs every *Bucket* test file).
  const roots: Array<string> = [];
  const nameFilters: Array<string> = [];
  for (const p of options.paths) {
    const abs = path.isAbsolute(p) ? p : path.resolve(options.root, p);
    const exists = yield* fs
      .exists(abs)
      .pipe(Effect.orElseSucceed(() => false));
    if (exists) {
      roots.push(abs);
    } else {
      nameFilters.push(p.toLowerCase());
    }
  }
  if (roots.length === 0) {
    roots.push(path.resolve(options.root, "test"));
  }

  for (const abs of roots) {
    const stat = yield* fs
      .stat(abs)
      .pipe(
        Effect.mapError(
          () => new Error(`alchemy-test: path not found: ${abs}`),
        ),
      );
    if (stat.type === "Directory") {
      yield* walk(abs);
    } else {
      files.push(abs);
    }
  }

  let unique = [...new Set(files)];
  if (nameFilters.length > 0) {
    unique = unique.filter((file) => {
      const rel = path.relative(options.root, file).toLowerCase();
      return nameFilters.some((filter) => rel.includes(filter));
    });
  }
  return unique.sort();
});

// ---------------------------------------------------------------------------
// Collection
// ---------------------------------------------------------------------------

export interface CollectedFile {
  readonly file: string;
  readonly suite: FileSuite | undefined;
  readonly error?: string | undefined;
}

const collectFile = (
  absolute: string,
  relative: string,
): Effect.Effect<CollectedFile> =>
  Effect.promise(async (): Promise<CollectedFile> => {
    const root = Registry.beginFile(relative);
    try {
      await import(pathToFileURL(absolute).href);
      // Flush microtasks + one macrotask so registrations deferred with
      // queueMicrotask (e.g. Test.make's fallback afterAll) land in the tree.
      await new Promise((resolve) => setTimeout(resolve, 0));
      return { file: relative, suite: root };
    } catch (error) {
      return {
        file: relative,
        suite: undefined,
        error:
          error instanceof Error
            ? (error.stack ?? error.message)
            : String(error),
      };
    } finally {
      Registry.endFile();
    }
  });

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

/**
 * Whole-process read/write lock. Normal tests hold a read permit; tests
 * registered with `{ exclusive: true }` (they mutate process-global state
 * like `process.env`) take every permit, so they never overlap with any
 * other test in the run.
 */
const EXCLUSIVE_PERMITS = 100_000;

interface ExecContext {
  readonly options: RunOptions;
  readonly onlyMode: boolean;
  readonly emit: (event: TestEvent) => Effect.Effect<void>;
  readonly fileLogs: Array<LogEntry>;
  /** File-level hook failures, counted once for the file in the run summary. */
  readonly fileErrors: Array<string>;
  readonly results: Array<{ meta: TestMeta; result: TestResult }>;
  readonly file: string;
  readonly lock: Semaphore.Semaphore;
  /** Run-global registry of currently-executing test fibers (for kill). */
  readonly running: Map<string, Fiber.Fiber<unknown, unknown>>;
  /** Run-global set of tests that have finished at least once (for retry). */
  readonly completed: Set<string>;
}

const metaOf = (file: string, test: TestCase): TestMeta => {
  const parts = titlePath(test);
  return {
    id: `${file} > ${parts.join(" > ")}`,
    file,
    titlePath: parts,
    name: test.name,
  };
};

/** Should this test run at all given only-mode and the -t filter? */
const included = (
  test: TestCase,
  ctx: Pick<ExecContext, "onlyMode" | "options" | "file">,
): boolean => {
  if (ctx.options.filter !== undefined) {
    // Match against the full nested title, so `-t` finds a test by any
    // fragment regardless of how it's nested in describe blocks.
    const full = `${ctx.file} > ${titlePath(test).join(" > ")}`;
    if (!ctx.options.filter(full)) {
      return false;
    }
  }
  if (ctx.onlyMode) {
    let node: Suite | TestCase | undefined = test;
    while (node !== undefined) {
      if (node.mode === "only") return true;
      node = node.parent;
    }
    return false;
  }
  return true;
};

const isSkipped = (test: TestCase): "skip" | "todo" | undefined => {
  if (test.mode === "todo" || test.body === undefined) return "todo";
  let node: Suite | TestCase | undefined = test;
  while (node !== undefined) {
    if (node.mode === "skip") return "skip";
    node = node.parent;
  }
  return undefined;
};

const hookChain = (
  test: TestCase,
  kind: "beforeEach" | "afterEach",
): Array<Hook> => {
  const chain: Array<Array<Hook>> = [];
  let suite: Suite | undefined = test.parent;
  while (suite !== undefined) {
    chain.unshift(suite[kind]);
    suite = suite.parent;
  }
  const flat = chain.flat();
  return kind === "afterEach" ? flat.reverse() : flat;
};

const runHooks = (
  hooks: ReadonlyArray<Hook>,
  defaultTimeout: number,
): Effect.Effect<void, unknown> =>
  Effect.forEach(
    hooks,
    (hook) =>
      Effect.suspend(hook.body).pipe(
        Effect.timeout(Duration.millis(hook.timeout ?? defaultTimeout)),
      ),
    { discard: true },
  );

const prettyCause = (cause: Cause.Cause<unknown>): string => {
  const rendered = Cause.pretty(cause);
  return stripAnsi(
    rendered.trim().length === 0 ? inspect(Cause.squash(cause)) : rendered,
  );
};

const wasInterrupted = (exit: Exit.Exit<unknown, unknown>): boolean =>
  Exit.isFailure(exit) &&
  exit.cause.reasons.some((reason) => reason._tag === "Interrupt");

interface TestAttempt {
  readonly beforeEach: Exit.Exit<void, unknown>;
  readonly body: Exit.Exit<unknown, unknown> | undefined;
  readonly afterEach: Exit.Exit<void, unknown>;
}

const attemptNeedsRetry = (
  exit: Exit.Exit<TestAttempt, unknown>,
  expectsFailure: boolean | undefined,
): boolean => {
  if (Exit.isFailure(exit)) return !wasInterrupted(exit);
  if (
    Exit.isFailure(exit.value.beforeEach) ||
    Exit.isFailure(exit.value.afterEach)
  ) {
    return true;
  }
  return (
    !expectsFailure &&
    exit.value.body !== undefined &&
    Exit.isFailure(exit.value.body)
  );
};

const hookError = (attempt: TestAttempt): string | undefined => {
  const errors: Array<string> = [];
  if (Exit.isFailure(attempt.beforeEach)) {
    errors.push(
      `beforeEach hook failed:\n${prettyCause(attempt.beforeEach.cause)}`,
    );
  }
  if (Exit.isFailure(attempt.afterEach)) {
    errors.push(
      `afterEach hook failed:\n${prettyCause(attempt.afterEach.cause)}`,
    );
  }
  return errors.length === 0 ? undefined : errors.join("\n\n");
};

const runTest = Effect.fn(function* (test: TestCase, ctx: ExecContext) {
  const meta = metaOf(ctx.file, test);
  const skipped = isSkipped(test);
  if (skipped !== undefined) {
    const result: TestResult = {
      status: skipped,
      durationMs: 0,
      logs: [],
      retries: 0,
    };
    ctx.results.push({ meta, result });
    yield* ctx.emit({ _tag: "TestEnd", test: meta, result });
    return;
  }

  // One stable buffer for the whole runTest call (cleared in place between
  // retry attempts) — TestStart shares the LIVE reference so the TUI can
  // tail a running test's output.
  const logs: Array<LogEntry> = [];
  yield* ctx.emit({ _tag: "TestStart", test: meta, logs });

  const timeoutMs = test.timeout ?? ctx.options.timeout;
  const before = hookChain(test, "beforeEach");
  const after = hookChain(test, "afterEach");

  const attempt = (): Effect.Effect<TestAttempt> => {
    // Store the finalizer's Exit separately so a teardown failure cannot be
    // swallowed or mistaken for an expected (`test.fails`) body failure.
    let afterExit: Exit.Exit<void, unknown> = Exit.succeed(undefined);
    return Effect.gen(function* () {
      const beforeExit = yield* runHooks(before, timeoutMs).pipe(Effect.exit);
      const bodyExit = Exit.isSuccess(beforeExit)
        ? yield* Effect.suspend(test.body!).pipe(
            Effect.timeout(Duration.millis(timeoutMs)),
            Effect.exit,
          )
        : undefined;
      return { beforeEach: beforeExit, body: bodyExit };
    }).pipe(
      // afterEach must run on success, failure and interruption alike. Its
      // own Exit is recorded without making the finalizer itself fail.
      Effect.onExit(() =>
        runHooks(after, timeoutMs).pipe(
          Effect.exit,
          Effect.tap((exit) =>
            Effect.sync(() => {
              afterExit = exit;
            }),
          ),
          Effect.asVoid,
        ),
      ),
      Effect.map(({ beforeEach, body }) => ({
        beforeEach,
        body,
        afterEach: afterExit,
      })),
      withCapture(logs),
    );
  };

  const start = Date.now();
  let retries = 0;
  const withLock = ctx.lock.withPermits(test.exclusive ? EXCLUSIVE_PERMITS : 1);

  // Each attempt runs in its own fiber, registered run-globally so the TUI's
  // kill command can interrupt it.
  const runAttempt = Effect.fn(function* (): Generator<
    Effect.Effect<any>,
    Exit.Exit<TestAttempt, unknown>
  > {
    const fiber = yield* Effect.forkChild(withLock(attempt()), {
      startImmediately: true,
    });
    ctx.running.set(meta.id, fiber);
    const exit: Exit.Exit<TestAttempt, unknown> = yield* Fiber.await(fiber);
    ctx.running.delete(meta.id);
    return exit;
  });

  let exit = yield* runAttempt();
  while (
    attemptNeedsRetry(exit, test.fails) &&
    retries < (test.retry ?? ctx.options.retry)
  ) {
    retries++;
    // Clear IN PLACE — TestStart handed this array's reference out.
    logs.length = 0;
    exit = yield* runAttempt();
  }
  const durationMs = Date.now() - start;

  let status: TestResult["status"];
  let error: string | undefined;
  if (wasInterrupted(exit)) {
    status = "fail";
    error = "killed (interrupted by user)";
  } else if (Exit.isFailure(exit)) {
    status = "fail";
    error = prettyCause(exit.cause);
  } else {
    const failedHook = hookError(exit.value);
    const bodyExit = exit.value.body;
    if (failedHook !== undefined) {
      status = "fail";
      error = failedHook;
    } else if (test.fails && bodyExit !== undefined) {
      if (Exit.isFailure(bodyExit)) {
        status = "pass";
      } else {
        status = "fail";
        error = "expected test to fail, but it passed";
      }
    } else if (bodyExit !== undefined && Exit.isSuccess(bodyExit)) {
      status = "pass";
    } else {
      status = "fail";
      error =
        bodyExit === undefined
          ? "test body did not run"
          : prettyCause(bodyExit.cause);
    }
  }

  ctx.completed.add(meta.id);
  const result: TestResult = { status, durationMs, error, logs, retries };
  ctx.results.push({ meta, result });
  yield* ctx.emit({ _tag: "TestEnd", test: meta, result });
});

/** Fail every (non-skipped) test in a subtree without running it. */
const failSubtree = Effect.fn(function* (
  suite: Suite,
  ctx: ExecContext,
  error: string,
) {
  const tests: Array<TestCase> = [];
  const collect = (s: Suite) => {
    for (const child of s.children) {
      if (child.type === "test") tests.push(child);
      else collect(child);
    }
  };
  collect(suite);
  for (const test of tests) {
    const meta = metaOf(ctx.file, test);
    if (!included(test, ctx)) continue;
    const skipped = isSkipped(test);
    const result: TestResult =
      skipped !== undefined
        ? { status: skipped, durationMs: 0, logs: [], retries: 0 }
        : {
            status: "fail",
            durationMs: 0,
            error: `beforeAll hook failed:\n${error}`,
            logs: [],
            retries: 0,
          };
    ctx.results.push({ meta, result });
    yield* ctx.emit({ _tag: "TestEnd", test: meta, result });
  }
});

const runSuite: (suite: Suite, ctx: ExecContext) => Effect.Effect<void> =
  Effect.fn(function* (suite: Suite, ctx: ExecContext) {
    const runnable = suite.children.filter((child) =>
      child.type === "test"
        ? included(child, ctx)
        : suiteHasIncludedTests(child, ctx),
    );
    if (runnable.length === 0) return;

    // If every included test below is skipped (e.g. describe.skip), report
    // them without running any hooks.
    if (!suiteHasRunnableTests(suite, ctx)) {
      yield* Effect.forEach(
        runnable,
        (child) =>
          child.type === "test" ? runTest(child, ctx) : runSuite(child, ctx),
        { discard: true },
      );
      return;
    }

    // beforeAll — captured into the file-level log buffer. Emits hook events
    // so the TUI can show "setting up" instead of an unexplained queue.
    if (suite.beforeAll.length > 0) {
      yield* ctx.emit({ _tag: "HookStart", file: ctx.file, hook: "beforeAll" });
      const exit = yield* runHooks(suite.beforeAll, ctx.options.timeout).pipe(
        withCapture(ctx.fileLogs),
        Effect.exit,
      );
      yield* ctx.emit({ _tag: "HookEnd", file: ctx.file, hook: "beforeAll" });
      if (Exit.isFailure(exit)) {
        yield* failSubtree(suite, ctx, prettyCause(exit.cause));
        yield* runAfterAll(suite, ctx);
        return;
      }
    }

    const sequential = suite.sequential || ctx.options.sequential;
    yield* Effect.forEach(
      runnable,
      (child) =>
        child.type === "test" ? runTest(child, ctx) : runSuite(child, ctx),
      { concurrency: sequential ? 1 : "unbounded", discard: true },
    );

    yield* runAfterAll(suite, ctx);
  });

const runAfterAll = Effect.fn(function* (suite: Suite, ctx: ExecContext) {
  if (suite.afterAll.length === 0) return;
  yield* ctx.emit({ _tag: "HookStart", file: ctx.file, hook: "afterAll" });
  const exit = yield* runHooks(suite.afterAll, ctx.options.timeout).pipe(
    withCapture(ctx.fileLogs),
    Effect.exit,
  );
  yield* ctx.emit({ _tag: "HookEnd", file: ctx.file, hook: "afterAll" });
  if (Exit.isFailure(exit)) {
    const error = `afterAll hook failed:\n${prettyCause(exit.cause)}`;
    ctx.fileErrors.push(error);
  }
});

const suiteHasIncludedTests = (
  suite: Suite,
  ctx: Pick<ExecContext, "onlyMode" | "options" | "file">,
): boolean => {
  for (const child of suite.children) {
    if (child.type === "test" && included(child, ctx)) return true;
    if (child.type === "suite" && suiteHasIncludedTests(child, ctx))
      return true;
  }
  return false;
};

/** True if the subtree has at least one included test that will actually run. */
const suiteHasRunnableTests = (
  suite: Suite,
  ctx: Pick<ExecContext, "onlyMode" | "options" | "file">,
): boolean => {
  for (const child of suite.children) {
    if (
      child.type === "test" &&
      included(child, ctx) &&
      isSkipped(child) === undefined
    ) {
      return true;
    }
    if (child.type === "suite" && suiteHasRunnableTests(child, ctx))
      return true;
  }
  return false;
};

// ---------------------------------------------------------------------------
// run
// ---------------------------------------------------------------------------

export const run = Effect.fn(function* (options: RunOptions) {
  const reporter = yield* Reporter;
  const path = yield* Path.Path;
  const startedAt = Date.now();

  // Every event is teed into the persistent run log (`.alchemy/log/test.log`)
  // in addition to the active reporter.
  const fileLog = yield* makeFileLog(options.logFile);
  const emit = (event: TestEvent): Effect.Effect<void> =>
    reporter.emit(event).pipe(Effect.andThen(fileLog.append(event)));

  const absoluteFiles = yield* discover(options).pipe(Effect.orDie);
  const relative = absoluteFiles.map((f) => path.relative(options.root, f));
  yield* emit({ _tag: "CollectStart", files: relative });

  // Phase 1 — import EVERY file before running anything. Imports are lazy
  // and pure (registration only), and must be serial anyway because the
  // registration state is global. Collecting fully up-front keeps run
  // semantics simple: `.only` applies across the whole run, and the full
  // test list is known before the first test starts.
  const collected: Array<CollectedFile> = [];
  for (let i = 0; i < absoluteFiles.length; i++) {
    // collectFile never fails — import errors are captured on the result.
    const c = yield* collectFile(absoluteFiles[i]!, relative[i]!);
    collected.push(c);
    yield* emit({ _tag: "FileCollected", file: relative[i]! });
  }

  const onlyMode = collected.some(
    (c) => c.suite !== undefined && containsOnly(c.suite),
  );

  // Announce the full test list before execution starts (drives the TUI).
  const allMetas: Array<TestMeta> = [];
  for (const c of collected) {
    if (c.suite === undefined) continue;
    const walk = (suite: Suite) => {
      for (const child of suite.children) {
        if (child.type === "test") {
          if (included(child, { onlyMode, options, file: c.file })) {
            allMetas.push(metaOf(c.file, child));
          }
        } else {
          walk(child);
        }
      }
    };
    walk(c.suite);
  }
  yield* emit({
    _tag: "RunStart",
    files: collected.length,
    tests: allMetas,
  });

  // Phase 2 — run files concurrently.
  const allResults: Array<{ meta: TestMeta; result: TestResult }> = [];
  const fileFailures: Array<{ file: string; error: string }> = [];
  const lock = yield* Semaphore.make(EXCLUSIVE_PERMITS);
  const running = new Map<string, Fiber.Fiber<unknown, unknown>>();
  const completed = new Set<string>();
  const testIndex = new Map<string, { test: TestCase; ctx: ExecContext }>();

  // Interactive control (TUI `r` retry / `x` kill). Retried tests re-run as
  // standalone forked fibers and re-emit TestStart/TestEnd through the same
  // reporter; the header counters simply update in place.
  const controller: RunController = {
    retryTest: (id) => {
      const entry = testIndex.get(id);
      if (entry === undefined || running.has(id) || !completed.has(id)) return;
      completed.delete(id);
      Effect.runFork(runTest(entry.test, entry.ctx));
    },
    retryFile: (file) => {
      for (const [id, entry] of testIndex) {
        if (entry.ctx.file === file) controller.retryTest(id);
      }
    },
    killTest: (id) => {
      const fiber = running.get(id);
      if (fiber !== undefined) Effect.runFork(Fiber.interrupt(fiber));
    },
  };
  if (reporter.attachController !== undefined) {
    yield* reporter.attachController(controller);
  }

  // Array whose pushes are teed to `tee` as they happen. File-hook output is
  // captured into this buffer over the (potentially very long) life of a
  // deploy/destroy hook; teeing each entry into the run log keeps the log
  // live instead of silent-until-FileEnd (which reads as a deadlocked run).
  const liveHookLogBuffer = (
    tee: (entry: LogEntry) => void,
  ): Array<LogEntry> => {
    const buffer: Array<LogEntry> = [];
    const push = Array.prototype.push.bind(buffer);
    buffer.push = (...entries: Array<LogEntry>) => {
      for (const entry of entries) tee(entry);
      return push(...entries);
    };
    return buffer;
  };

  const runFile = Effect.fn(function* (c: CollectedFile) {
    const fileLogs = liveHookLogBuffer((entry) =>
      fileLog.appendHookLine(c.file, entry),
    );
    const fileErrors: Array<string> = [];
    // Shares the LIVE hook-log buffer so the TUI can tail deploys.
    yield* emit({ _tag: "FileStart", file: c.file, logs: fileLogs });
    let fileError = c.error;
    if (c.suite !== undefined) {
      const ctx: ExecContext = {
        options,
        onlyMode,
        emit,
        fileLogs,
        fileErrors,
        results: allResults,
        file: c.file,
        lock,
        running,
        completed,
      };
      forEachTest(c.suite, (test) => {
        if (included(test, ctx) && isSkipped(test) === undefined) {
          testIndex.set(metaOf(c.file, test).id, { test, ctx });
        }
      });
      const exit = yield* runSuite(c.suite, ctx).pipe(Effect.exit);
      if (Exit.isFailure(exit)) {
        fileError = prettyCause(exit.cause);
      } else if (fileErrors.length > 0) {
        fileError = fileErrors.join("\n\n");
      }
    }
    if (fileError !== undefined) {
      fileFailures.push({ file: c.file, error: fileError });
    }
    yield* emit({
      _tag: "FileEnd",
      file: c.file,
      logs: fileLogs,
      error: fileError,
    });
  });

  yield* Effect.forEach(collected, runFile, {
    concurrency: options.concurrency,
    discard: true,
  });

  const failures = allResults.filter((r) => r.result.status === "fail");
  const summary: RunSummary = {
    files: collected.length,
    passed: allResults.filter((r) => r.result.status === "pass").length,
    failed: failures.length + fileFailures.length,
    skipped: allResults.filter((r) => r.result.status === "skip").length,
    todo: allResults.filter((r) => r.result.status === "todo").length,
    durationMs: Date.now() - startedAt,
    failures,
    fileFailures,
  };
  yield* emit({ _tag: "RunEnd", summary });
  // Drain the live hook-line queue so tail lines from the final file's
  // hooks are on disk before the process exits.
  yield* fileLog.close;
  return summary;
});

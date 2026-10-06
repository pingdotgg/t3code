/**
 * Single-process test runner.
 *
 * Discovers `*.test.ts` files, imports them concurrently with an AsyncLocalStorage
 * per-file collector (see Registry.ts), then executes every collected
 * test as an Effect — files run concurrently up to a limit, tests within a
 * file run sequentially unless their suite is `describe.concurrent`. Each
 * test gets a buffering Effect Logger + Console so its output can be shown
 * in isolation.
 */
import * as Cause from "effect/Cause";
import * as ConsoleModule from "effect/Console";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Semaphore from "effect/Semaphore";
import { inspect } from "node:util";
import { pathToFileURL } from "node:url";

import { makeFileLog } from "./FileLog.ts";
import type { FileSuite, Hook, LogEntry, Suite, TestCase } from "./Model.ts";
import { containsOnly, forEachTest, titlePath } from "./Model.ts";
import type { TestPlan } from "./Plan.ts";
import * as Registry from "./Registry.ts";
import { compileTagsFilter, type TagsFilter } from "./Tags.ts";
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
   * Exclusion filters (`--exclude`). Existing files/directories exclude by
   * path prefix; anything else is a case-insensitive substring exclusion on
   * test file paths. A positional root explicitly given inside an excluded
   * path overrides the exclusion (so `alchemy-test test/Railway` still works
   * when the package script bakes in `--exclude test/Railway`).
   */
  readonly exclude?: ReadonlyArray<string> | undefined;
  /**
   * `-t` test-name filter, applied to the full title
   * (`file > describe chain > name`).
   */
  readonly filter?: ((fullTitle: string) => boolean) | undefined;
  /** Match the combined suite and test tags, in addition to other filters. */
  readonly tagsFilter?: ReadonlyArray<string>;
  readonly plan?: TestPlan | undefined;
  readonly dryRun?: boolean;
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
  // Roots the user asked for explicitly (before defaulting to `test`) are
  // exempt from `--exclude` — a baked-in package-script exclusion must not
  // make `alchemy-test test/Railway/Foo.test.ts` silently run nothing.
  const explicitRoots = [...roots];
  if (roots.length === 0) {
    roots.push(path.resolve(options.root, "test"));
  }

  // Excludes mirror positional semantics: existing paths exclude by prefix,
  // anything else is a case-insensitive substring exclusion.
  const excludePrefixes: Array<string> = [];
  const excludeSubstrings: Array<string> = [];
  for (const e of options.exclude ?? []) {
    const abs = path.isAbsolute(e) ? e : path.resolve(options.root, e);
    const exists = yield* fs
      .exists(abs)
      .pipe(Effect.orElseSucceed(() => false));
    if (exists) {
      excludePrefixes.push(abs);
    } else {
      excludeSubstrings.push(e.toLowerCase());
    }
  }
  const isWithin = (file: string, dir: string): boolean =>
    file === dir || file.startsWith(dir + path.sep);
  const isExcluded = (file: string): boolean => {
    if (excludePrefixes.some((prefix) => isWithin(file, prefix))) return true;
    const rel = path.relative(options.root, file).toLowerCase();
    return excludeSubstrings.some((substring) => rel.includes(substring));
  };
  const exemptRoots = explicitRoots.filter(isExcluded);

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
  if (excludePrefixes.length > 0 || excludeSubstrings.length > 0) {
    unique = unique.filter(
      (file) =>
        exemptRoots.some((root) => isWithin(file, root)) || !isExcluded(file),
    );
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
    try {
      const suite = await Registry.collect(relative, async () => {
        await import(pathToFileURL(absolute).href);
        // Flush microtasks + one macrotask so registrations deferred with
        // queueMicrotask (e.g. Test.make's fallback afterAll) land in the
        // tree — their AsyncLocalStorage context resolves this file's collector.
        await new Promise<void>((resolve) => setImmediate(resolve));
      });
      return { file: relative, suite };
    } catch (error) {
      return {
        file: relative,
        suite: undefined,
        error:
          error instanceof Error
            ? (error.stack ?? error.message)
            : String(error),
      };
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

const hookPermits = (hooks: ReadonlyArray<Hook>): number =>
  hooks.some((hook) => hook.exclusive === true) ? EXCLUSIVE_PERMITS : 1;

interface ExecContext {
  readonly options: Omit<RunOptions, "tagsFilter"> & {
    readonly tagsFilter: TagsFilter;
    readonly selectedTests?: ReadonlySet<TestCase>;
  };
  readonly suiteStates?: Map<Suite, Exit.Exit<void, unknown>>;
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
    tags: test.tags,
    optInTags: test.optInTags,
  };
};

/** Should this test run at all given only-mode and the -t filter? */
const included = (
  test: TestCase,
  ctx: Pick<ExecContext, "onlyMode" | "options" | "file">,
): boolean => {
  if (
    ctx.options.selectedTests !== undefined &&
    !ctx.options.selectedTests.has(test)
  )
    return false;
  if (
    ctx.options.tagsFilter !== undefined &&
    !ctx.options.tagsFilter(test.tags, test.optInTags)
  ) {
    return false;
  }
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
  if (test.mode === "todo") return "todo";
  let node: Suite | TestCase | undefined = test;
  while (node !== undefined) {
    if (node.mode === "skip") return "skip";
    node = node.parent;
  }
  // Wrappers (e.g. alchemy's `test.skipIf`) drop the body of skipped tests,
  // so a missing body only means "todo" once skip has been ruled out.
  return test.body === undefined ? "todo" : undefined;
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

/**
 * How long a timed-out test body's interruption (finalizers included) may
 * run before the runner abandons the fiber and reports the timeout anyway.
 * Without this bound, a finalizer blocked on the same wedged machinery the
 * timeout just interrupted (e.g. a `test.provider` scratch destroy against
 * a hung dev deploy) swallows the report entirely — the test never finishes
 * and the run dies at the wall clock with no error attribution.
 */
const INTERRUPT_GRACE_MS = 10_000;

/**
 * Run a test body with a timeout that cannot be swallowed by hung
 * finalizers: on timeout the body fiber is interrupted, its finalizers get
 * {@link INTERRUPT_GRACE_MS} to settle, and then the fiber is abandoned
 * (it dies with the run) and the timeout is reported.
 */
const runBodyWithTimeout = Effect.fn(function* (
  body: () => Effect.Effect<unknown, unknown>,
  timeoutMs: number,
) {
  // Detached: a timed-out body whose teardown never settles must not block
  // the attempt fiber's own completion (a supervised child would).
  const fiber = yield* Effect.forkDetach(Effect.suspend(body), {
    startImmediately: true,
  });
  const awaited = yield* Fiber.await(fiber).pipe(
    Effect.timeoutOption(Duration.millis(timeoutMs)),
  );
  if (Option.isSome(awaited)) return awaited.value;
  // Fire-and-forget interrupt: `Fiber.interrupt` AWAITS settlement, which a
  // hung finalizer never provides. Fire it, then give teardown a bounded
  // grace before abandoning the fiber (it dies with the process).
  yield* Effect.sync(() => fiber.interruptUnsafe());
  const settled = yield* Fiber.await(fiber).pipe(
    Effect.timeoutOption(Duration.millis(INTERRUPT_GRACE_MS)),
  );
  return Exit.fail(
    new Error(
      Option.isNone(settled)
        ? `test timed out after ${timeoutMs}ms (teardown did not settle within ${INTERRUPT_GRACE_MS}ms and was abandoned)`
        : `test timed out after ${timeoutMs}ms`,
    ),
  ) as Exit.Exit<unknown, unknown>;
});

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
        ? yield* runBodyWithTimeout(test.body!, timeoutMs)
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

  let durationMs = 0;
  let retries = 0;
  const withLock = ctx.lock.withPermits(test.exclusive ? EXCLUSIVE_PERMITS : 1);

  // Each attempt runs in its own fiber, registered run-globally so the TUI's
  // kill command can interrupt it.
  const runAttempt = Effect.fn(function* (): Generator<
    Effect.Effect<any>,
    Exit.Exit<TestAttempt, unknown>
  > {
    const fiber = yield* Effect.forkChild(
      withLock(
        Effect.suspend(() => {
          // Queue time behind an exclusive test is not execution time. Sum only
          // attempts (including their hooks), retaining time spent on retries.
          const start = Date.now();
          return attempt().pipe(
            Effect.ensuring(
              Effect.sync(() => {
                durationMs += Date.now() - start;
              }),
            ),
          );
        }),
      ),
      {
        startImmediately: true,
      },
    );
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
    const previousSetup = ctx.suiteStates?.get(suite);
    if (previousSetup !== undefined && Exit.isFailure(previousSetup)) {
      yield* failSubtree(suite, ctx, prettyCause(previousSetup.cause));
      return;
    }
    if (previousSetup === undefined && suite.beforeAll.length > 0) {
      yield* ctx.emit({ _tag: "HookStart", file: ctx.file, hook: "beforeAll" });
      // Honor `{ exclusive: true }` on the hook (Hetzner quota, Railway
      // plugin DBs). Non-exclusive beforeAll keeps the default 1-permit
      // slot so unrelated files can still run concurrently.
      const exit = yield* ctx.lock
        .withPermits(hookPermits(suite.beforeAll))(
          runHooks(suite.beforeAll, ctx.options.timeout),
        )
        .pipe(withCapture(ctx.fileLogs), Effect.exit);
      yield* ctx.emit({ _tag: "HookEnd", file: ctx.file, hook: "beforeAll" });
      ctx.suiteStates?.set(suite, exit);
      if (Exit.isFailure(exit)) {
        yield* failSubtree(suite, ctx, prettyCause(exit.cause));
        if (ctx.suiteStates === undefined) yield* runAfterAll(suite, ctx);
        return;
      }
    }

    if (ctx.suiteStates !== undefined && !ctx.suiteStates.has(suite))
      ctx.suiteStates.set(suite, Exit.succeed(undefined));

    const sequential = suite.sequential || ctx.options.sequential;
    yield* Effect.forEach(
      runnable,
      (child) =>
        child.type === "test" ? runTest(child, ctx) : runSuite(child, ctx),
      { concurrency: sequential ? 1 : "unbounded", discard: true },
    );

    if (ctx.suiteStates === undefined) yield* runAfterAll(suite, ctx);
  });

const runAfterAll = Effect.fn(function* (suite: Suite, ctx: ExecContext) {
  if (suite.afterAll.length === 0) return;
  yield* ctx.emit({ _tag: "HookStart", file: ctx.file, hook: "afterAll" });
  // Unlike beforeAll (where a failure invalidates everything after it),
  // every teardown hook runs even when an earlier one fails: a failing
  // teardown assertion must not drop later cleanup — in particular
  // Test.make's fallback hook that closes the shared scope and local
  // provider sidecar, which registers last and would otherwise leak the
  // sidecar for the rest of the process. Failures aggregate.
  const afterAllRun = Effect.forEach(suite.afterAll, (hook) =>
    Effect.suspend(hook.body).pipe(
      Effect.timeout(Duration.millis(hook.timeout ?? ctx.options.timeout)),
      Effect.exit,
    ),
  );
  const exits = yield* ctx.lock
    .withPermits(hookPermits(suite.afterAll))(afterAllRun)
    .pipe(withCapture(ctx.fileLogs));
  yield* ctx.emit({ _tag: "HookEnd", file: ctx.file, hook: "afterAll" });
  const failures = exits.filter(Exit.isFailure);
  if (failures.length > 0) {
    const error = `afterAll hook failed:\n${failures
      .map((exit) => prettyCause(exit.cause))
      .join("\n")}`;
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

export const run = Effect.fn(function* (input: RunOptions) {
  const options = {
    ...input,
    tagsFilter: compileTagsFilter(input.tagsFilter ?? []),
  };
  const reporter = yield* Reporter;
  const path = yield* Path.Path;
  const startedAt = Date.now();

  // Every event is teed into the persistent run log (`.alchemy/log/test.log`)
  // in addition to the active reporter.
  const fileLog = yield* makeFileLog(options.logFile);
  const emit = (event: TestEvent): Effect.Effect<void> =>
    reporter.emit(event).pipe(Effect.andThen(fileLog.append(event)));

  const absoluteFiles = yield* discover(input).pipe(Effect.orDie);
  const relative = absoluteFiles.map((f) => path.relative(options.root, f));
  yield* emit({ _tag: "CollectStart", files: relative });

  // Import every file before running anything so `.only` applies across
  // the whole run. AsyncLocalStorage keeps registrations attached to their
  // file while imports overlap. Bound collection to avoid loader saturation.
  const collectConcurrency =
    options.concurrency === "unbounded"
      ? 32
      : Math.min(options.concurrency, 32);
  // collectFile never fails — import errors are captured on the result.
  const collected = yield* Effect.forEach(
    absoluteFiles.map((absolute, i) => [absolute, relative[i]!] as const),
    ([absolute, rel]) =>
      collectFile(absolute, rel).pipe(
        Effect.tap(() => emit({ _tag: "FileCollected", file: rel })),
      ),
    { concurrency: collectConcurrency },
  );

  const onlyMode = collected.some(
    (c) => c.suite !== undefined && containsOnly(c.suite),
  );

  // Assign each case once, in phase/branch declaration order, before execution.
  const assigned = new Set<TestCase>();
  const remainingFileBranches = new Map<string, number>();
  const candidates: Array<{ file: string; test: TestCase }> = [];
  const candidateOptions = {
    ...options,
    tagsFilter: (
      tags: ReadonlyArray<string>,
      optInTags: ReadonlyArray<string> = [],
    ) => options.tagsFilter([...tags, ...optInTags], []),
  };
  for (const c of collected) {
    if (c.suite !== undefined)
      forEachTest(c.suite, (test) => {
        if (
          included(test, { onlyMode, options: candidateOptions, file: c.file })
        )
          candidates.push({ file: c.file, test });
      });
  }
  const phases = (input.plan ?? [{ tags: [] }]).map((phase) =>
    (Array.isArray(phase) ? phase : [phase]).map((branch) => {
      const tagsFilter = compileTagsFilter([
        ...(input.tagsFilter ?? []),
        ...branch.tags,
      ]);
      const selectedTests = new Set<TestCase>();
      const selectedFiles = new Set<string>();
      for (const { file, test } of candidates) {
        if (!assigned.has(test) && tagsFilter(test.tags, test.optInTags)) {
          assigned.add(test);
          selectedFiles.add(file);
          selectedTests.add(test);
        }
      }
      for (const file of selectedFiles) {
        remainingFileBranches.set(
          file,
          (remainingFileBranches.get(file) ?? 0) + 1,
        );
      }
      return {
        ...options,
        tagsFilter,
        expressions: [...(input.tagsFilter ?? []), ...branch.tags],
        selectedTests,
        concurrency: branch.concurrency ?? options.concurrency,
      };
    }),
  );
  const allMetas = candidates
    .filter(({ test }) => assigned.has(test))
    .map(({ file, test }) => metaOf(file, test));
  if (input.dryRun) {
    yield* emit({
      _tag: "PlanPreview",
      phases: phases.map((branches) =>
        branches.map((branch) => {
          const matched = candidates.filter(({ test }) =>
            branch.selectedTests.has(test),
          );
          return {
            tags: branch.expressions,
            concurrency: branch.concurrency,
            tests: matched.length,
            files: new Set(matched.map(({ file }) => file)).size,
            skipped: matched.filter(({ test }) => isSkipped(test) !== undefined)
              .length,
          };
        }),
      ),
    });
    const fileFailures = collected.flatMap((c) =>
      c.error === undefined ? [] : [{ file: c.file, error: c.error }],
    );
    for (const failure of fileFailures)
      yield* emit({ _tag: "FileEnd", ...failure, logs: [] });
    const summary: RunSummary = {
      dryRun: true,
      files: collected.length,
      plan: {
        found: candidates.length,
        selected: assigned.size,
        excluded: candidates.length - assigned.size,
      },
      passed: 0,
      failed: fileFailures.length,
      skipped: 0,
      todo: 0,
      durationMs: Date.now() - startedAt,
      failures: [],
      fileFailures,
    };
    yield* emit({ _tag: "RunEnd", summary });
    yield* fileLog.close;
    return summary;
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

  const fileContexts = new Map<string, ExecContext>();
  const fileLocks = new Map<string, Semaphore.Semaphore>();
  for (const c of collected) fileLocks.set(c.file, yield* Semaphore.make(1));
  const runFile = Effect.fn(function* (
    c: CollectedFile,
    branchOptions: ExecContext["options"],
  ) {
    const previous = fileContexts.get(c.file);
    const fileLogs =
      previous?.fileLogs ??
      liveHookLogBuffer((entry) => fileLog.appendHookLine(c.file, entry));
    const fileErrors = previous?.fileErrors ?? [];
    // Shares the LIVE hook-log buffer so the TUI can tail deploys.
    if (previous === undefined)
      yield* emit({ _tag: "FileStart", file: c.file, logs: fileLogs });
    let fileError = c.error;
    if (c.suite !== undefined) {
      const ctx: ExecContext = {
        options: branchOptions,
        suiteStates:
          input.plan === undefined
            ? undefined
            : (previous?.suiteStates ?? new Map()),
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
      fileContexts.set(c.file, ctx);
      forEachTest(c.suite, (test) => {
        if (included(test, ctx) && isSkipped(test) === undefined) {
          testIndex.set(metaOf(c.file, test).id, { test, ctx });
        }
      });
      const exit = yield* runSuite(c.suite, ctx).pipe(Effect.exit);
      if (Exit.isFailure(exit)) {
        fileError = prettyCause(exit.cause);
      } else if (input.plan === undefined && fileErrors.length > 0) {
        fileError = fileErrors.join("\n\n");
      }
    }
    if (fileError !== undefined) {
      fileFailures.push({ file: c.file, error: fileError });
    }
    if (input.plan !== undefined && c.suite !== undefined) {
      // Count completed visits rather than declaration order: branches in a
      // phase run concurrently, and any of them may finish this file last.
      const remaining = remainingFileBranches.get(c.file)! - 1;
      remainingFileBranches.set(c.file, remaining);
      if (remaining > 0) return;

      // Keep scopes only while another selected branch still needs the file.
      // Teardown stays inside its concurrency slot and per-file lock so new
      // files cannot accumulate resources retained until the end of a phase.
      const ctx = fileContexts.get(c.file)!;
      for (const suite of [...ctx.suiteStates!.keys()].reverse())
        yield* runAfterAll(suite, ctx);
      if (ctx.fileErrors.length > 0)
        fileFailures.push({
          file: ctx.file,
          error: ctx.fileErrors.join("\n\n"),
        });
      fileError =
        fileFailures
          .filter((failure) => failure.file === c.file)
          .map((failure) => failure.error)
          .join("\n\n") || undefined;
    }
    yield* emit({
      _tag: "FileEnd",
      file: c.file,
      logs: fileLogs,
      error: fileError,
    });
  });

  // Import errors are reported once even if no branch selects that file.
  yield* Effect.forEach(
    collected.filter((c) => c.error !== undefined),
    (c) => runFile(c, options),
  );
  for (const [index, branches] of phases.entries()) {
    if (input.plan !== undefined)
      yield* emit({
        _tag: "PlanPhaseStart",
        phase: index + 1,
        phases: phases.length,
        tests: branches.reduce(
          (count, branch) => count + branch.selectedTests.size,
          0,
        ),
      });
    yield* Effect.forEach(
      branches,
      (branch) =>
        Effect.forEach(
          collected.filter(
            (c) =>
              c.suite !== undefined &&
              suiteHasIncludedTests(c.suite, {
                file: c.file,
                onlyMode,
                options: branch,
              }),
          ),
          (c) => fileLocks.get(c.file)!.withPermits(1)(runFile(c, branch)),
          { concurrency: branch.concurrency, discard: true },
        ),
      { concurrency: "unbounded", discard: true },
    );
  }

  const failures = allResults.filter((r) => r.result.status === "fail");
  const summary: RunSummary = {
    files: collected.length,
    plan:
      input.plan === undefined
        ? undefined
        : {
            found: candidates.length,
            selected: assigned.size,
            excluded: candidates.length - assigned.size,
          },
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

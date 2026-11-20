import { pathToFileURL } from "node:url";
import { inspect } from "node:util";
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
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Semaphore from "effect/Semaphore";
import { makeCapture } from "./Capture.ts";
import { makeFileLog, type FileLog } from "./FileLog.ts";
import type { Exclusive, FileSuite, Hook, LogEntry, Suite, TestCase } from "./Model.ts";
import { containsOnly, forEachTest, makeFileSuite, titlePath } from "./Model.ts";
import type { TestPlan } from "./Plan.ts";
import * as Registry from "./Registry.ts";
import {
  Reporter,
  type RunController,
  type RunSummary,
  type TestEvent,
  type TestMeta,
  type TestResult,
} from "./Reporter.ts";
import { compileTagsFilter, type TagsFilter } from "./Tags.ts";

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
  stripAnsi(typeof value === "string" ? value : inspect(value, { depth: 4, colors: false }));

const formatArgs = (args: ReadonlyArray<unknown>): string => args.map(formatArg).join(" ");

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
      push("info", [`${label ?? "default"}: ${start === undefined ? "?" : Date.now() - start}ms`]);
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
            const parts = Array.isArray(options.message) ? options.message : [options.message];
            logs.push({
              level: options.logLevel,
              message:
                parts.map(formatArg).join(" ") +
                (options.cause.reasons.length === 0 ? "" : `\n${Cause.pretty(options.cause)}`),
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

  const walk: (dir: string) => Effect.Effect<void, unknown, FileSystem.FileSystem> = Effect.fn(
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
    const exists = yield* fs.exists(abs).pipe(Effect.orElseSucceed(() => false));
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
    const exists = yield* fs.exists(abs).pipe(Effect.orElseSucceed(() => false));
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
      .pipe(Effect.mapError(() => new Error(`alchemy-test: path not found: ${abs}`)));
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
      (file) => exemptRoots.some((root) => isWithin(file, root)) || !isExcluded(file),
    );
  }
  return unique.sort();
});

// ---------------------------------------------------------------------------
// Collection
// ---------------------------------------------------------------------------

export interface CollectedFile {
  readonly file: string;
  readonly suite: FileSuite;
  readonly error?: string | undefined;
}

const collectFile = (
  absolute: string,
  relative: string,
  suite: FileSuite,
): Effect.Effect<CollectedFile> =>
  Effect.promise(async (): Promise<CollectedFile> => {
    try {
      await Registry.collect(
        relative,
        async () => {
          await import(pathToFileURL(absolute).href);
          // Flush microtasks + one macrotask so registrations deferred with
          // queueMicrotask (e.g. Test.make's fallback afterAll) land in the
          // tree while this file's collector is still the active one.
          await new Promise<void>((resolve) => setImmediate(resolve));
        },
        suite,
      );
      return { file: relative, suite };
    } catch (error) {
      return {
        file: relative,
        suite,
        error: error instanceof Error ? (error.stack ?? error.message) : String(error),
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
 * other test in the run. A label (`{ exclusive: "hetzner" }`) instead takes
 * a per-label lock plus a normal read permit, so it only serializes with
 * holders of the same label.
 */
const EXCLUSIVE_PERMITS = 100_000;

interface LockSpec {
  readonly global: boolean;
  /** Sorted, so holders of several labels acquire them in one order. */
  readonly labels: ReadonlyArray<string>;
}

const lockSpec = (values: ReadonlyArray<Exclusive | undefined>): LockSpec => ({
  global: values.some((value) => value === true),
  labels: [
    ...new Set(
      values.filter((value): value is string => typeof value === "string" && value !== ""),
    ),
  ].sort(),
});

interface RunLock {
  readonly withLock: (
    spec: LockSpec,
  ) => <A, E, R>(self: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
}

/**
 * Opportunistic exclusive lock. An exclusive acquirer asks for every permit
 * and gets them only once nothing else holds one; everyone else keeps taking
 * single permits meanwhile, because Effect's `Semaphore` grants whoever asks
 * while enough are free. So an exclusive test never stalls the run: in a busy
 * run it waits for a quiet moment, at worst the tail of its phase.
 *
 * Writer preference (holding a gate while waiting) would bound that wait, but
 * at the cost of freezing every test started meanwhile behind the slowest one
 * in flight: a 25-minute ElastiCache update held up the whole AWS suite.
 */
const makeRunLock = Effect.gen(function* () {
  const permits = yield* Semaphore.make(EXCLUSIVE_PERMITS);
  const labels = new Map<string, Semaphore.Semaphore>();
  const labelLock = (label: string): Semaphore.Semaphore => {
    let lock = labels.get(label);
    if (lock === undefined) {
      lock = Semaphore.makeUnsafe(1);
      labels.set(label, lock);
    }
    return lock;
  };
  const lock: RunLock = {
    withLock:
      (spec) =>
      <A, E, R>(self: Effect.Effect<A, E, R>) => {
        if (spec.global) return permits.withPermits(EXCLUSIVE_PERMITS)(self);
        // Take labels before the read permit: a queued label holder must not
        // sit on a read permit that a waiting global writer needs.
        const shared = permits.withPermits(1)(self);
        return spec.labels.reduceRight(
          (inner, label) => labelLock(label).withPermits(1)(inner),
          shared,
        );
      },
  };
  return lock;
});

const testLock = (test: TestCase): LockSpec => lockSpec([test.exclusive]);

const hookLock = (hooks: ReadonlyArray<Hook>): LockSpec =>
  lockSpec(hooks.map((hook) => hook.exclusive));

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
  readonly results: Map<string, { meta: TestMeta; result: TestResult }>;
  readonly interactive: boolean;
  readonly capture: ReturnType<typeof makeCapture>;
  readonly fileLog: FileLog;
  readonly fileFinished: Deferred.Deferred<void>;
  /** Files whose abandoned work may still own resources; their teardown is skipped. */
  readonly abandoned: Set<string>;
  readonly file: string;
  readonly lock: RunLock;
  /** Run-global registry of currently-executing test fibers (for kill). */
  readonly running: Map<string, Fiber.Fiber<unknown, unknown>>;
  /** Run-global set of tests that have finished at least once (for retry). */
  readonly completed: Set<string>;
}

// Weak keys preserve retry identity without retaining finished tests or their suites.
const testIds = new WeakMap<TestCase, string>();
let nextTestId = 0;

const metaOf = (file: string, test: TestCase): TestMeta => {
  let id = testIds.get(test);
  if (id === undefined) {
    id = `test-${++nextTestId}`;
    testIds.set(test, id);
  }
  const parts = titlePath(test);
  return {
    id,
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
  if (ctx.options.selectedTests !== undefined && !ctx.options.selectedTests.has(test)) return false;
  if (ctx.options.tagsFilter !== undefined && !ctx.options.tagsFilter(test.tags, test.optInTags)) {
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

const hookChain = (test: TestCase, kind: "beforeEach" | "afterEach"): Array<Hook> => {
  const chain: Array<Array<Hook>> = [];
  let suite: Suite | undefined = test.parent;
  while (suite !== undefined) {
    chain.unshift(suite[kind]);
    suite = suite.parent;
  }
  const flat = chain.flat();
  return kind === "afterEach" ? flat.reverse() : flat;
};

/**
 * Run hooks in order, each bounded by {@link runWithDeadline}: a hook that
 * outlives its timeout (`hook.timeout`, else the test/file default) fails
 * and is abandoned after the teardown grace, exactly like a test body.
 */
const runHooks = (
  hooks: ReadonlyArray<Hook>,
  defaultTimeout: number,
  ctx: ExecContext,
): Effect.Effect<void, unknown> =>
  Effect.forEach(
    hooks,
    (hook) =>
      runWithDeadline(hook.body, hook.timeout ?? defaultTimeout, "hook", ctx).pipe(
        Effect.flatMap((exit) =>
          Exit.isFailure(exit) ? Effect.failCause(exit.cause) : Effect.void,
        ),
      ),
    { discard: true },
  );

const prettyCause = (cause: Cause.Cause<unknown>): string => {
  const rendered = Cause.pretty(cause);
  return stripAnsi(rendered.trim().length === 0 ? inspect(Cause.squash(cause)) : rendered);
};

const wasInterrupted = (exit: Exit.Exit<unknown, unknown>): boolean =>
  Exit.isFailure(exit) && exit.cause.reasons.some((reason) => reason._tag === "Interrupt");

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
  if (Exit.isFailure(exit.value.beforeEach) || Exit.isFailure(exit.value.afterEach)) {
    return true;
  }
  return !expectsFailure && exit.value.body !== undefined && Exit.isFailure(exit.value.body);
};

const hookError = (attempt: TestAttempt): string | undefined => {
  const errors: Array<string> = [];
  if (Exit.isFailure(attempt.beforeEach)) {
    errors.push(`beforeEach hook failed:\n${prettyCause(attempt.beforeEach.cause)}`);
  }
  if (Exit.isFailure(attempt.afterEach)) {
    errors.push(`afterEach hook failed:\n${prettyCause(attempt.afterEach.cause)}`);
  }
  return errors.length === 0 ? undefined : errors.join("\n\n");
};

/**
 * How long a timed-out test body's or hook's interruption (finalizers
 * included) may run before the runner abandons the fiber and reports the
 * timeout anyway. Without this bound, a finalizer blocked on the same wedged
 * machinery the timeout just interrupted (e.g. a `test.provider` scratch
 * destroy against a hung dev deploy) — or simply an uninterruptible region —
 * swallows the report entirely: the test/hook never finishes and the run
 * (or the `--plan` phase) never advances.
 *
 * Overridable via `ALCHEMY_TEST_TEARDOWN_GRACE_MS` (used by the runner's own
 * regression tests to keep them fast).
 */
const INTERRUPT_GRACE_MS = (() => {
  const raw = Number(process.env.ALCHEMY_TEST_TEARDOWN_GRACE_MS);
  return Number.isFinite(raw) && raw >= 0 ? raw : 10_000;
})();

/**
 * Run `body` with a deadline that can NEVER be outlived. Used for every test
 * body and every hook (beforeAll / beforeEach / afterEach / afterAll / file
 * cleanups).
 *
 * `Effect.timeout` is not enough: it interrupts the loser and AWAITS its
 * interruption, which never completes when the work is in an uninterruptible
 * region or a finalizer hangs. Instead the work runs in a detached fiber; on
 * timeout (or when the caller is interrupted) it is interrupted, given
 * {@link INTERRUPT_GRACE_MS} to settle, and then abandoned (it dies with the
 * process) while the timeout is reported and the run continues. An abandoned
 * fiber may still own its file's resources, so the file is marked abandoned
 * and its remaining teardown (afterEach / afterAll / file cleanups) is skipped
 * rather than racing it.
 */
const runWithDeadline = Effect.fnUntraced(function* (
  body: () => Effect.Effect<unknown, unknown>,
  timeoutMs: number,
  label: "test" | "hook",
  ctx: Pick<ExecContext, "abandoned" | "file">,
) {
  // Detached: work whose teardown never settles must not block the caller
  // fiber's own completion (a supervised child would).
  const fiber = yield* Effect.forkDetach(Effect.interruptible(Effect.suspend(body)), {
    startImmediately: true,
  });
  // Fire-and-forget interrupt: `Fiber.interrupt` AWAITS settlement, which a
  // hung finalizer never provides. Fire it, then give teardown a bounded
  // grace before abandoning the fiber. Succeeds with whether it settled.
  const settle = Effect.gen(function* () {
    fiber.interruptUnsafe();
    const settled = yield* Fiber.await(fiber).pipe(
      Effect.timeoutOption(Duration.millis(INTERRUPT_GRACE_MS)),
    );
    if (Option.isNone(settled)) ctx.abandoned.add(ctx.file);
    return Option.isSome(settled);
  });
  return yield* Effect.gen(function* () {
    const awaited = yield* Fiber.await(fiber).pipe(
      Effect.timeoutOption(Duration.millis(timeoutMs)),
    );
    if (Option.isSome(awaited)) return awaited.value as Exit.Exit<unknown, unknown>;
    const settled = yield* settle;
    return Exit.fail(
      new Error(
        !settled
          ? `${label} timed out after ${timeoutMs}ms (teardown did not settle within ${INTERRUPT_GRACE_MS}ms and was abandoned)`
          : `${label} timed out after ${timeoutMs}ms`,
      ),
    ) as Exit.Exit<unknown, unknown>;
  }).pipe(Effect.onExit((exit) => (wasInterrupted(exit) ? settle : Effect.void)));
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
    ctx.results.set(meta.id, {
      meta,
      result: ctx.interactive || result.status === "fail" ? result : { ...result, logs: [] },
    });
    yield* ctx.emit({ _tag: "TestEnd", test: meta, result });
    return;
  }

  // One stable buffer for the whole runTest call (cleared in place between
  // retry attempts) — TestStart shares the LIVE reference so the TUI can
  // tail a running test's output.
  const logs = ctx.capture.create((entry) =>
    ctx.fileLog.appendTestLine(`${meta.file} > ${meta.titlePath.join(" > ")}`, entry),
  );
  yield* ctx.emit({ _tag: "TestStart", test: meta, logs });

  const timeoutMs = test.timeout ?? ctx.options.timeout;
  const before = hookChain(test, "beforeEach");
  const after = hookChain(test, "afterEach");

  const attempt = (): Effect.Effect<TestAttempt> => {
    // Store the finalizer's Exit separately so a teardown failure cannot be
    // swallowed or mistaken for an expected (`test.fails`) body failure.
    let afterExit: Exit.Exit<void, unknown> = Exit.succeed(undefined);
    return Effect.gen(function* () {
      const beforeExit = yield* runHooks(before, timeoutMs, ctx).pipe(Effect.exit);
      const bodyExit = Exit.isSuccess(beforeExit)
        ? yield* runWithDeadline(test.body!, timeoutMs, "test", ctx)
        : undefined;
      return { beforeEach: beforeExit, body: bodyExit };
    }).pipe(
      // afterEach must run on success, failure and interruption alike. Its
      // own Exit is recorded without making the finalizer itself fail.
      Effect.onExit(() =>
        ctx.abandoned.has(ctx.file)
          ? Effect.void
          : runHooks(after, timeoutMs, ctx).pipe(
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
  const withLock = ctx.lock.withLock(testLock(test));

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
          return ctx.emit({ _tag: "TestLocked", test: meta }).pipe(
            Effect.andThen(attempt()),
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
    return yield* Fiber.await(fiber).pipe(
      Effect.ensuring(Fiber.interrupt(fiber)),
      Effect.ensuring(Effect.sync(() => ctx.running.delete(meta.id))),
    );
  });

  let exit = yield* runAttempt();
  while (attemptNeedsRetry(exit, test.fails) && retries < (test.retry ?? ctx.options.retry)) {
    retries++;
    // Clear IN PLACE — TestStart handed this array's reference out.
    ctx.capture.release(logs);
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
      error = bodyExit === undefined ? "test body did not run" : prettyCause(bodyExit.cause);
    }
  }

  if (ctx.interactive) ctx.completed.add(meta.id);
  const result: TestResult = { status, durationMs, error, logs, retries };
  ctx.results.set(meta.id, {
    meta,
    result: ctx.interactive || result.status === "fail" ? result : { ...result, logs: [] },
  });
  yield* ctx.emit({ _tag: "TestEnd", test: meta, result });
  if (!ctx.interactive && status !== "fail") ctx.capture.release(logs);
});

/** Fail every (non-skipped) test in a subtree without running it. */
const failSubtree = Effect.fn(function* (suite: Suite, ctx: ExecContext, error: string) {
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
    ctx.results.set(meta.id, {
      meta,
      result: ctx.interactive || result.status === "fail" ? result : { ...result, logs: [] },
    });
    yield* ctx.emit({ _tag: "TestEnd", test: meta, result });
  }
});

const runSuite: (suite: Suite, ctx: ExecContext) => Effect.Effect<void> = Effect.fn(function* (
  suite: Suite,
  ctx: ExecContext,
) {
  const runnable = suite.children.filter((child) =>
    child.type === "test" ? included(child, ctx) : suiteHasIncludedTests(child, ctx),
  );
  if (runnable.length === 0) return;

  // If every included test below is skipped (e.g. describe.skip), report
  // them without running any hooks.
  if (!suiteHasRunnableTests(suite, ctx)) {
    yield* Effect.forEach(
      runnable,
      (child) => (child.type === "test" ? runTest(child, ctx) : runSuite(child, ctx)),
      { discard: true },
    );
    return;
  }

  // A plan runs a suite's beforeAll once, in the first phase that reaches
  // it; later phases reuse (or re-report the failure of) that setup.
  const previousSetup = ctx.suiteStates?.get(suite);
  if (previousSetup !== undefined && Exit.isFailure(previousSetup)) {
    yield* failSubtree(suite, ctx, prettyCause(previousSetup.cause));
    return;
  }

  const body = Effect.gen(function* () {
    // beforeAll — captured into the file-level log buffer. Emits hook events
    // so the TUI can show "setting up" instead of an unexplained queue.
    if (previousSetup === undefined && suite.beforeAll.length > 0) {
      yield* ctx.emit({
        _tag: "HookStart",
        file: ctx.file,
        hook: "beforeAll",
      });
      // Honor `exclusive` on the hook (`true` for the whole run, a label
      // like "hetzner" for a shared quota). Non-exclusive beforeAll keeps
      // the default 1-permit slot so unrelated files can still run.
      const exit = yield* ctx.lock
        .withLock(hookLock(suite.beforeAll))(runHooks(suite.beforeAll, ctx.options.timeout, ctx))
        .pipe(withCapture(ctx.fileLogs), Effect.exit);
      yield* ctx.emit({ _tag: "HookEnd", file: ctx.file, hook: "beforeAll" });
      ctx.suiteStates?.set(suite, exit);
      if (Exit.isFailure(exit)) {
        yield* failSubtree(suite, ctx, prettyCause(exit.cause));
        return;
      }
    }

    if (ctx.suiteStates !== undefined && !ctx.suiteStates.has(suite))
      ctx.suiteStates.set(suite, Exit.succeed(undefined));

    const sequential = suite.sequential || ctx.options.sequential;
    yield* Effect.forEach(
      runnable,
      (child) => (child.type === "test" ? runTest(child, ctx) : runSuite(child, ctx)),
      { concurrency: sequential ? 1 : "unbounded", discard: true },
    );
  });

  if (ctx.suiteStates === undefined)
    return yield* body.pipe(Effect.ensuring(runAfterAll(suite, ctx)));
  // Planned runs defer afterAll to the file's last phase. Record a setup
  // interrupted before it settled so that teardown still covers it.
  return yield* body.pipe(
    Effect.onInterrupt(() =>
      Effect.sync(() => {
        if (!ctx.suiteStates!.has(suite)) ctx.suiteStates!.set(suite, Exit.interrupt());
      }),
    ),
  );
});

const runAfterAll = Effect.fn(function* (suite: Suite, ctx: ExecContext) {
  if (suite.afterAll.length === 0 || ctx.abandoned.has(ctx.file)) return;
  yield* ctx.emit({ _tag: "HookStart", file: ctx.file, hook: "afterAll" });
  // Unlike beforeAll (where a failure invalidates everything after it),
  // every teardown hook runs even when an earlier one fails: a failing
  // teardown assertion must not drop later cleanup — in particular
  // Test.make's fallback hook that closes the shared scope and local
  // provider sidecar, which registers last and would otherwise leak the
  // sidecar for the rest of the process. Failures aggregate.
  const afterAllRun = Effect.forEach(suite.afterAll, (hook) =>
    ctx.abandoned.has(ctx.file)
      ? Effect.succeed(Exit.void)
      : runWithDeadline(hook.body, hook.timeout ?? ctx.options.timeout, "hook", ctx),
  );
  const exits = yield* ctx.lock
    .withLock(hookLock(suite.afterAll))(afterAllRun)
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
    if (child.type === "suite" && suiteHasIncludedTests(child, ctx)) return true;
  }
  return false;
};

/** True if the subtree has at least one included test that will actually run. */
const suiteHasRunnableTests = (
  suite: Suite,
  ctx: Pick<ExecContext, "onlyMode" | "options" | "file">,
): boolean => {
  for (const child of suite.children) {
    if (child.type === "test" && included(child, ctx) && isSkipped(child) === undefined) {
      return true;
    }
    if (child.type === "suite" && suiteHasRunnableTests(child, ctx)) return true;
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
  const capture = makeCapture();
  const emit = (event: TestEvent): Effect.Effect<void> =>
    reporter.emit(event).pipe(Effect.andThen(fileLog.append(event)));

  const absoluteFiles = yield* discover(input).pipe(Effect.orDie);
  const relative = absoluteFiles.map((f) => path.relative(options.root, f));
  yield* emit({ _tag: "CollectStart", files: relative });
  const roots = relative.map(makeFileSuite);
  const lock = yield* makeRunLock;
  const abandoned = new Set<string>();
  const disposed = new Set<FileSuite>();
  const cleanupErrors = new Map<string, string>();
  const retryFibers = new Set<Fiber.Fiber<void, never>>();
  const running = new Map<string, Fiber.Fiber<unknown, unknown>>();
  const completed = new Set<string>();
  const testIndex = new Map<string, { test: TestCase; ctx: ExecContext }>();
  let acceptingRetries = true;

  const clearSuite = (suite: Suite): void => {
    for (const child of suite.children) {
      if (child.type === "suite") clearSuite(child);
    }
    suite.children.length = 0;
    suite.beforeAll.length = 0;
    suite.afterAll.length = 0;
    suite.beforeEach.length = 0;
    suite.afterEach.length = 0;
  };
  const disposeFile = Effect.fn(function* (suite: FileSuite) {
    if (disposed.has(suite) || abandoned.has(suite.file)) return;
    disposed.add(suite);
    const errors: Array<string> = [];
    for (const hook of suite.cleanups.splice(0)) {
      const exit = yield* lock.withLock(hookLock([hook]))(
        runWithDeadline(hook.body, hook.timeout ?? options.timeout, "hook", {
          file: suite.file,
          abandoned,
        }),
      );
      if (Exit.isFailure(exit)) errors.push(prettyCause(exit.cause));
      if (abandoned.has(suite.file)) break;
    }
    if (errors.length > 0) {
      cleanupErrors.set(suite.file, `file cleanup failed:\n${errors.join("\n")}`);
    }
    if (!abandoned.has(suite.file)) clearSuite(suite);
  }, Effect.uninterruptible);
  // Registered before imports: partial and never-executed files own resources too.
  yield* Effect.addFinalizer(() =>
    Effect.gen(function* () {
      acceptingRetries = false;
      for (const fiber of retryFibers) fiber.interruptUnsafe();
      yield* Effect.forEach(retryFibers, (fiber) => Fiber.await(fiber), {
        discard: true,
      });
      yield* Effect.forEach(roots, disposeFile, { discard: true });
      testIndex.clear();
      completed.clear();
      running.clear();
      yield* fileLog.close;
      if (cleanupErrors.size > 0) {
        return yield* Effect.die(
          new Error(
            [...cleanupErrors.entries()].map(([file, error]) => `${file}: ${error}`).join("\n\n"),
          ),
        );
      }
    }),
  );

  // Import every file before running anything so `.only` applies across
  // the whole run. AsyncLocalStorage keeps registrations attached to their
  // file while imports overlap. Bound collection to avoid loader saturation.
  const collectConcurrency =
    options.concurrency === "unbounded" ? 32 : Math.min(options.concurrency, 32);
  // collectFile never fails — import errors are captured on the result.
  const collected = yield* Effect.forEach(
    absoluteFiles.map((absolute, i) => [absolute, relative[i]!, roots[i]!] as const),
    ([absolute, rel, suite]) =>
      collectFile(absolute, rel, suite).pipe(
        Effect.tap(() => emit({ _tag: "FileCollected", file: rel })),
        Effect.uninterruptible,
      ),
    { concurrency: collectConcurrency },
  );

  const onlyMode = collected.some((c) => c.error === undefined && containsOnly(c.suite));

  // Assign each case once, in phase/branch declaration order, before execution.
  const assigned = new Set<TestCase>();
  const remainingFileBranches = new Map<string, number>();
  const candidates: Array<{ file: string; test: TestCase }> = [];
  const candidateOptions = {
    ...options,
    tagsFilter: (tags: ReadonlyArray<string>, optInTags: ReadonlyArray<string> = []) =>
      options.tagsFilter([...tags, ...optInTags], []),
  };
  for (const c of collected) {
    // Import-failed files keep their partial suite (for cleanup) but run nothing.
    if (c.error === undefined)
      forEachTest(c.suite, (test) => {
        if (included(test, { onlyMode, options: candidateOptions, file: c.file }))
          candidates.push({ file: c.file, test });
      });
  }
  const phases = (input.plan ?? [{ tags: [] }]).map((phase) =>
    (Array.isArray(phase) ? phase : [phase]).map((branch) => {
      const tagsFilter = compileTagsFilter([...(input.tagsFilter ?? []), ...branch.tags]);
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
        remainingFileBranches.set(file, (remainingFileBranches.get(file) ?? 0) + 1);
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
          const matched = candidates.filter(({ test }) => branch.selectedTests.has(test));
          return {
            tags: branch.expressions,
            concurrency: branch.concurrency,
            tests: matched.length,
            files: new Set(matched.map(({ file }) => file)).size,
            skipped: matched.filter(({ test }) => isSkipped(test) !== undefined).length,
          };
        }),
      ),
    });
    const fileFailures = collected.flatMap((c) =>
      c.error === undefined ? [] : [{ file: c.file, error: c.error }],
    );
    for (const failure of fileFailures) yield* emit({ _tag: "FileEnd", ...failure, logs: [] });
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
    // The run finalizer closes the log after disposing partially imported files.
    return summary;
  }
  yield* emit({
    _tag: "RunStart",
    files: collected.length,
    tests: allMetas,
  });

  // Phase 2 — run files concurrently.
  const allResults = new Map<string, { meta: TestMeta; result: TestResult }>();
  const fileFailures: Array<{ file: string; error: string }> = [];
  const interactive = reporter.attachController !== undefined;

  // Interactive control (TUI `r` retry / `x` kill). Retried tests re-run as
  // standalone forked fibers and re-emit TestStart/TestEnd through the same
  // reporter; the header counters simply update in place.
  const controller: RunController = {
    retryTest: (id) => {
      const entry = testIndex.get(id);
      if (
        !acceptingRetries ||
        entry === undefined ||
        abandoned.has(entry.ctx.file) ||
        running.has(id) ||
        !completed.has(id)
      )
        return;
      completed.delete(id);
      const fiber = Effect.runFork(
        Deferred.await(entry.ctx.fileFinished).pipe(Effect.andThen(runTest(entry.test, entry.ctx))),
      );
      retryFibers.add(fiber);
      fiber.addObserver(() => retryFibers.delete(fiber));
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

  interface FileRun {
    readonly suite: FileSuite;
    /** Context of the latest branch; buffers and suite states are shared. */
    ctx: ExecContext;
    /** Import and runner errors, reported once when the file finishes. */
    readonly errors: Array<string>;
    retryable: boolean;
    tornDown: boolean;
    finished: boolean;
  }
  const fileRuns = new Map<string, FileRun>();
  const fileLocks = new Map<string, Semaphore.Semaphore>();
  for (const c of collected) fileLocks.set(c.file, yield* Semaphore.make(1));

  // Planned runs close cached suites child-first once, after the file's last branch.
  const teardownSuites = Effect.fn(function* (run: FileRun) {
    if (run.tornDown || run.ctx.suiteStates === undefined) return;
    run.tornDown = true;
    for (const suite of [...run.ctx.suiteStates.keys()].reverse())
      yield* runAfterAll(suite, run.ctx);
  });

  const finishFile = Effect.fn(function* (run: FileRun) {
    if (run.finished) return;
    run.finished = true;
    const { ctx } = run;
    yield* teardownSuites(run);
    if (!run.retryable) yield* disposeFile(run.suite).pipe(withCapture(ctx.fileLogs));
    const errors = [...run.errors];
    if (ctx.fileErrors.length > 0) errors.push(ctx.fileErrors.join("\n\n"));
    const cleanupError = cleanupErrors.get(ctx.file);
    cleanupErrors.delete(ctx.file);
    if (cleanupError !== undefined) errors.push(cleanupError);
    const fileError = errors.length === 0 ? undefined : errors.join("\n\n");
    if (fileError !== undefined) {
      fileFailures.push({ file: ctx.file, error: fileError });
    }
    yield* emit({
      _tag: "FileEnd",
      file: ctx.file,
      logs: ctx.fileLogs,
      error: fileError,
    });
    yield* Deferred.succeed(ctx.fileFinished, undefined);
  });

  const runFile = Effect.fn(function* (c: CollectedFile, branchOptions: ExecContext["options"]) {
    const previous = fileRuns.get(c.file);
    if (previous?.finished) return;
    const fileLogs =
      previous?.ctx.fileLogs ?? capture.create((entry) => fileLog.appendHookLine(c.file, entry));
    // Shares the LIVE hook-log buffer so the TUI can tail deploys.
    if (previous === undefined) yield* emit({ _tag: "FileStart", file: c.file, logs: fileLogs });
    const ctx: ExecContext = {
      options: branchOptions,
      suiteStates: input.plan === undefined ? undefined : (previous?.ctx.suiteStates ?? new Map()),
      onlyMode,
      emit,
      fileLogs,
      fileErrors: previous?.ctx.fileErrors ?? [],
      results: allResults,
      file: c.file,
      lock,
      running,
      completed,
      interactive,
      abandoned,
      capture,
      fileLog,
      fileFinished: previous?.ctx.fileFinished ?? (yield* Deferred.make<void>()),
    };
    const run: FileRun = previous ?? {
      suite: c.suite,
      ctx,
      errors: [],
      retryable: false,
      tornDown: false,
      finished: false,
    };
    run.ctx = ctx;
    fileRuns.set(c.file, run);
    if (c.error !== undefined) {
      if (!run.errors.includes(c.error)) run.errors.push(c.error);
    } else {
      if (interactive && suiteHasRunnableTests(c.suite, ctx)) {
        run.retryable = true;
        forEachTest(c.suite, (test) => {
          if (included(test, ctx) && isSkipped(test) === undefined) {
            testIndex.set(metaOf(c.file, test).id, { test, ctx });
          }
        });
      }
      const exit = yield* runSuite(c.suite, ctx).pipe(Effect.exit);
      if (Exit.isFailure(exit)) run.errors.push(prettyCause(exit.cause));
    }
    if (input.plan !== undefined && c.error === undefined) {
      // Count completed visits rather than declaration order: branches in a
      // phase run concurrently, and any of them may finish this file last.
      const remaining = remainingFileBranches.get(c.file)! - 1;
      remainingFileBranches.set(c.file, remaining);
      // Keep scopes only while another selected branch still needs the file.
      if (remaining > 0) return;
    }
    // Teardown stays inside the file's concurrency slot and per-file lock so
    // new files cannot accumulate resources retained until the end of a phase.
    yield* finishFile(run);
  });

  if (input.plan === undefined) {
    // Unplanned runs visit every file in order so each finishes (and disposes
    // its cleanups) as soon as it completes, even when nothing in it runs.
    const branch = phases[0]![0]!;
    yield* Effect.forEach(collected, (c) => runFile(c, branch), {
      concurrency: options.concurrency,
      discard: true,
    });
  } else {
    // Import errors are reported once even if no branch selects that file.
    yield* Effect.forEach(
      collected.filter((c) => c.error !== undefined),
      (c) => runFile(c, options),
      { discard: true },
    );
    yield* Effect.gen(function* () {
      for (const [index, branches] of phases.entries()) {
        yield* emit({
          _tag: "PlanPhaseStart",
          phase: index + 1,
          phases: phases.length,
          tests: branches.reduce((count, branch) => count + branch.selectedTests.size, 0),
        });
        yield* Effect.forEach(
          branches,
          (branch) =>
            Effect.forEach(
              collected.filter(
                (c) =>
                  c.error === undefined &&
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
    }).pipe(
      // An interrupted plan still owes every started suite its afterAll.
      Effect.ensuring(
        Effect.suspend(() =>
          Effect.forEach([...fileRuns.values()], teardownSuites, {
            concurrency: options.concurrency,
            discard: true,
          }),
        ),
      ),
    );
  }

  const count = (status: TestResult["status"]) => {
    let total = 0;
    for (const { result } of allResults.values()) if (result.status === status) total++;
    return total;
  };
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
    get passed() {
      return count("pass");
    },
    get failed() {
      return count("fail") + fileFailures.length;
    },
    get skipped() {
      return count("skip");
    },
    get todo() {
      return count("todo");
    },
    durationMs: Date.now() - startedAt,
    get failures() {
      return [...allResults.values()].filter(({ result }) => result.status === "fail");
    },
    fileFailures,
  };
  yield* emit({ _tag: "RunEnd", summary });
  // The log and retry-owned resources stay open until the reporter exits.
  return summary;
});

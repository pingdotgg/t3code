/** @effect-diagnostics anyUnknownInErrorContext:off */

import type { AlchemyContext } from "alchemy/AlchemyContext";
import type { CompiledStack, StackDefinition } from "alchemy/Stack";
import type { Stage } from "alchemy/Stage";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Core from "./Core.ts";
/**
 * Test adapter for the `alchemy-test` runner (see `packages/alchemy-test`).
 *
 * Same shape as {@link "./Vitest.ts"} / {@link "./Bun.ts"}, but registers
 * tests as raw Effects with the alchemy-test harness so the single-process
 * runner can inject a buffering Logger/Console per test and manage
 * concurrency + timeouts itself.
 */
import {
  currentFile,
  exclusiveOf,
  registerFileCleanup,
  registerHook,
  registerTest,
  retryOf,
  tagsOf,
  optInTagsOf,
  timeoutOf,
  type TestOptions,
} from "./index.ts";

export {
  executeWhenReady,
  getWhenReady,
  guardContentType,
  guardedFetchLayer,
  rpcClientLayer,
  WorkerNotReady,
  type EdgeGuardOptions,
  type WhenReadyOptions,
} from "./Http.ts";

export type MakeOptions<ROut = any> = Core.MakeOptions<ROut>;
export type ScratchStack = Core.ScratchStack;
export type TestEffect<A, R = never> = Core.TestEffect<A, R>;
export const ALCHEMY_TEST_DEV = Core.ALCHEMY_TEST_DEV;
export const resolveDev = Core.resolveDev;
export const defaultStage = Core.defaultStage;
export const resolveStage = Core.resolveStage;
export const captureResourceLog = Core.captureResourceLog;

interface TestFn {
  (name: string, eff: TestEffect<void>, options?: TestOptions): void;
  skip: (name: string, eff: TestEffect<void>, options?: TestOptions) => void;
  skipIf: (
    condition: boolean,
  ) => (name: string, eff: TestEffect<void>, options?: TestOptions) => void;
  only: (name: string, eff: TestEffect<void>, options?: TestOptions) => void;
  todo: (name: string, eff: TestEffect<void>, options?: TestOptions) => void;
  provider: ProviderFn;
}

interface ProviderFn {
  (
    name: string,
    fn: (stack: ScratchStack) => Effect.Effect<void, any, any>,
    options?: TestOptions,
  ): void;
  skip: (
    name: string,
    fn: (stack: ScratchStack) => Effect.Effect<void, any, any>,
    options?: TestOptions,
  ) => void;
  skipIf: (
    condition: boolean,
  ) => (
    name: string,
    fn: (stack: ScratchStack) => Effect.Effect<void, any, any>,
    options?: TestOptions,
  ) => void;
  todo: (
    name: string,
    fn: (stack: ScratchStack) => Effect.Effect<void, any, any>,
    options?: TestOptions,
  ) => void;
}

interface BeforeAllFn {
  <A>(eff: TestEffect<A>, options?: TestOptions): Effect.Effect<A>;
}

interface BeforeEachFn {
  (eff: TestEffect<void>, options?: TestOptions): void;
}

interface AfterAllFn {
  (eff: TestEffect<any>, options?: TestOptions): void;
  skipIf: (predicate: boolean) => (eff: TestEffect<any>, options?: TestOptions) => void;
}

interface AfterEachFn {
  (eff: TestEffect<void>, options?: TestOptions): void;
}

export interface TestApi {
  test: TestFn;
  beforeAll: BeforeAllFn;
  beforeEach: BeforeEachFn;
  afterAll: AfterAllFn;
  afterEach: AfterEachFn;
  deploy: Core.Deploy;
  destroy: <ROut>(
    stack: StackDefinition<ROut>,
    options?: { stage?: string; include?: never; exclude?: never },
  ) => ReturnType<typeof Core.destroy>;
}

const DEFAULT_TIMEOUT = 120_000;

/**
 * Build the per-file test API. Configure providers / state once at the top of
 * the test file:
 *
 * ```ts
 * import * as Test from "@alchemy.run/test/Alchemy";
 * import * as Cloudflare from "@alchemy.run/cloudflare";
 *
 * const { test, deploy, destroy, beforeAll, afterAll } = Test.make({
 *   providers: Cloudflare.providers(),
 *   state: Cloudflare.state(),
 * });
 * ```
 */
export const make = <ROut = any>(options: MakeOptions<ROut>): TestApi => {
  // Single scope shared across `beforeAll`, every `test`, and `afterAll`.
  // Scoped resources in dev mode (the Cloudflare dev proxy and its workerd
  // children) must outlive a single test boundary, otherwise the proxy is
  // killed the moment `beforeAll(deploy(Stack))` resolves and every later
  // `HttpClient.get(workerUrl)` hits a dead port. The scope is closed by
  // `destroy(...)` (or by file cleanup below).
  let sharedScope: Scope.Closeable | undefined = Scope.makeUnsafe("sequential");
  // Session ownership outlives a mid-file destroy, but not file cleanup.
  let sidecar = Core.makeSidecarHandle(options);
  const clearResults = new Set<() => void>();
  const wrap = <A>(eff: TestEffect<A>) =>
    sharedScope === undefined
      ? Effect.die("Test runtime is closed")
      : Core.toEffect(eff, options, sharedScope, sidecar);

  const addTest = (
    name: string,
    eff: TestEffect<void>,
    opts: TestOptions | undefined,
    mode: "run" | "skip" | "only" | "todo",
  ) =>
    registerTest({
      name,
      mode,
      exclusive: exclusiveOf(opts),
      retry: retryOf(opts),
      timeout: timeoutOf(opts),
      tags: tagsOf(opts),
      optInTags: optInTagsOf(opts),
      body: mode === "skip" || mode === "todo" ? undefined : () => wrap(eff),
    });

  const test = ((name, eff, opts) => {
    addTest(name, eff, opts, "run");
  }) as TestFn;

  test.skip = (name, eff, opts) => addTest(name, eff, opts, "skip");
  test.skipIf = (condition) => (name, eff, opts) =>
    addTest(name, eff, opts, condition ? "skip" : "run");
  test.only = (name, eff, opts) => addTest(name, eff, opts, "only");
  test.todo = (name, eff, opts) => addTest(name, eff, opts, "todo");

  // One lock per scratch stack. When an attempt times out, the runner fires
  // an interrupt and ABANDONS the attempt's fiber after a short grace — but
  // the fiber keeps running its teardown (`scratch.destroy()` below) in the
  // background, e.g. a CloudFront disable-wait. Without this lock the retry
  // starts concurrently on the SAME scratch state: the stale teardown then
  // deletes the state rows the retry just wrote for the same logical ids,
  // orphaning the retry's cloud resources (observed: two leaked CloudFront
  // distributions + buckets + OACs from one retried test). Holding the lock
  // across body + teardown makes a retry wait (on its own timeout clock)
  // until the previous attempt's teardown has fully settled.
  const scratchLocks = new Map<string, Semaphore.Semaphore>();
  const scratchLock = (name: string) => {
    let lock = scratchLocks.get(name);
    if (lock === undefined) {
      lock = Semaphore.makeUnsafe(1);
      scratchLocks.set(name, lock);
    }
    return lock;
  };

  const wrapProvider = (
    name: string,
    fn: (stack: ScratchStack) => Effect.Effect<void, any, any>,
    file: string | undefined,
  ) => {
    if (sharedScope === undefined) return Effect.die("Test runtime is closed");
    // Durable, file-namespaced scratch state (`.alchemy/state`). A run that
    // dies mid-delete — e.g. the runner abandons teardown 10s after a test
    // timeout while a CloudFront disable-wait is still in flight — leaves
    // its `deleting` rows on disk, so the NEXT run's leading
    // `stack.destroy()` (or the ensuring teardown below) resumes and drains
    // them instead of planning "no changes" and silently orphaning the
    // cloud resource.
    const scratch = Core.scratchStack(options, name, file);
    // Guarantee teardown. `test.provider` has no built-in cleanup, so a body
    // that fails (assertion, API error like a 409/Unauthorized) or is
    // interrupted (timeout) BEFORE its trailing `stack.destroy()` would
    // otherwise leak every cloud resource it deployed.
    // `scratch.destroy()` is idempotent — a no-op when the body already
    // destroyed, and it reclaims the orphans otherwise. `Effect.ensuring`
    // runs the finalizer on success, failure, AND interruption.
    const body = Core.withProviders(fn(scratch), options, scratch.name).pipe(
      Effect.ensuring(scratch.destroy().pipe(Effect.ignore)),
      scratchLock(scratch.name).withPermits(1),
    );
    return Core.toEffect(body, { ...options, state: scratch.state }, sharedScope, sidecar);
  };

  const addProvider = (
    name: string,
    fn: (stack: ScratchStack) => Effect.Effect<void, any, any>,
    opts: TestOptions | undefined,
    mode: "run" | "skip" | "todo",
  ) => {
    // Captured at registration (module evaluation during collection) — the
    // collection context is gone by the time the body runs.
    const file = currentFile();
    registerTest({
      name,
      mode,
      exclusive: exclusiveOf(opts),
      retry: retryOf(opts),
      timeout: timeoutOf(opts),
      tags: tagsOf(opts),
      optInTags: optInTagsOf(opts),
      body: mode === "run" ? () => wrapProvider(name, fn, file) : undefined,
    });
  };

  const provider = ((name, fn, opts) => {
    addProvider(name, fn, opts, "run");
  }) as ProviderFn;
  provider.skip = (name, fn, opts) => addProvider(name, fn, opts, "skip");
  provider.skipIf = (condition) => (name, fn, opts) =>
    addProvider(name, fn, opts, condition ? "skip" : "run");
  provider.todo = (name, fn, opts) => addProvider(name, fn, opts, "todo");
  test.provider = provider;

  const beforeAll: BeforeAllFn = <A>(eff: TestEffect<A>, hookOptions?: TestOptions) => {
    let result: A | undefined;
    clearResults.add(() => {
      result = undefined;
    });
    registerHook("beforeAll", {
      body: () =>
        wrap(eff).pipe(
          Effect.map((value) => {
            if (sharedScope !== undefined) result = value;
          }),
        ),
      timeout: timeoutOf(hookOptions) ?? DEFAULT_TIMEOUT,
      exclusive: exclusiveOf(hookOptions),
    });
    return Effect.sync(() => result as A);
  };

  const beforeEach: BeforeEachFn = (eff, hookOptions) => {
    registerHook("beforeEach", { body: () => wrap(eff), timeout: timeoutOf(hookOptions) });
  };

  const afterAll = ((eff, hookOptions) => {
    registerHook("afterAll", {
      body: () => wrap(eff),
      timeout: timeoutOf(hookOptions) ?? DEFAULT_TIMEOUT,
      exclusive: exclusiveOf(hookOptions),
    });
  }) as AfterAllFn;
  afterAll.skipIf = (predicate) => (eff, hookOptions) => {
    if (predicate) return;
    registerHook("afterAll", {
      body: () => wrap(eff),
      timeout: timeoutOf(hookOptions) ?? DEFAULT_TIMEOUT,
      exclusive: exclusiveOf(hookOptions),
    });
  };

  const afterEach: AfterEachFn = (eff, hookOptions) => {
    registerHook("afterEach", { body: () => wrap(eff), timeout: timeoutOf(hookOptions) });
  };

  // `destroy(Stack)` needs the dev sidecar alive so it can call `sidecar.stop`
  // for each worker. We close the shared scope only AFTER destroy completes.
  // `Scope.close` on an already-closed scope is a no-op, so it's safe for both
  // the destroy wrapper AND the fallback cleanup hook below to call it.
  const closeScope = Effect.suspend(() =>
    sharedScope === undefined ? Effect.void : Scope.close(sharedScope, Exit.void),
  ).pipe(Effect.ignore);

  // File cleanup runs after user afterAll, including skipped/failed imports.
  // Interactive retries retain the runtime until the runner releases the file.
  registerFileCleanup({
    body: () =>
      closeScope.pipe(
        Effect.ensuring(Effect.suspend(() => sidecar?.close ?? Effect.void)),
        Effect.ensuring(
          Effect.sync(() => {
            sharedScope = undefined;
            sidecar = undefined;
            for (const clear of clearResults) clear();
            clearResults.clear();
          }),
        ),
      ),
    timeout: DEFAULT_TIMEOUT,
  });

  return {
    test,
    beforeAll,
    beforeEach,
    afterAll,
    afterEach,
    deploy: Core.makeDeploy(options, sharedScope),
    destroy: (stack, callOpts) =>
      Core.destroy(options, stack, { ...callOpts, scope: sharedScope }).pipe(
        Effect.ensuring(closeScope),
      ),
  };
};

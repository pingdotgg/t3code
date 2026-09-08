/** @effect-diagnostics anyUnknownInErrorContext:off */

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
  registerHook,
  registerTest,
  retryOf,
  timeoutOf,
  type TestOptions,
} from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Scope from "effect/Scope";

import type { AlchemyContext } from "../AlchemyContext.ts";
import type { CompiledStack } from "../Stack.ts";
import type { Stage } from "../Stage.ts";
import * as Core from "./Core.ts";

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
}

interface BeforeAllFn {
  <A>(eff: TestEffect<A>, options?: TestOptions): Effect.Effect<A>;
}

interface BeforeEachFn {
  (eff: TestEffect<void>, options?: TestOptions): void;
}

interface AfterAllFn {
  (eff: TestEffect<any>, options?: TestOptions): void;
  skipIf: (
    predicate: boolean,
  ) => (eff: TestEffect<any>, options?: TestOptions) => void;
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
  deploy: <A>(
    stack: TestEffect<CompiledStack<A>, Stage | AlchemyContext>,
    options?: { stage?: string },
  ) => ReturnType<typeof Core.deploy<A>>;
  destroy: (
    stack: TestEffect<CompiledStack, Stage | AlchemyContext>,
    options?: { stage?: string },
  ) => ReturnType<typeof Core.destroy>;
}

const DEFAULT_TIMEOUT = 120_000;

/**
 * Build the per-file test API. Configure providers / state once at the top of
 * the test file:
 *
 * ```ts
 * import * as Test from "@/Test/Alchemy";
 * import * as Cloudflare from "@/Cloudflare";
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
  // `destroy(...)` (or by the fallback afterAll below).
  const sharedScope = Scope.makeUnsafe("sequential");
  // In dev mode, run local providers behind one file-scoped RPC sidecar
  // (the `alchemy dev` topology). Lives in its own scope — NOT sharedScope,
  // which `destroy(Stack)` closes mid-file in self-contained tests — and is
  // closed by the fallback afterAll below.
  const sidecar = Core.makeSidecarHandle(options);
  const wrap = <A>(eff: TestEffect<A>) =>
    Core.toEffect(eff, options, sharedScope, sidecar);

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

  const wrapProvider = (
    name: string,
    fn: (stack: ScratchStack) => Effect.Effect<void, any, any>,
    file: string | undefined,
  ) => {
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
    );
    return Core.toEffect(
      body,
      { ...options, state: scratch.state },
      sharedScope,
      sidecar,
    );
  };

  const addProvider = (
    name: string,
    fn: (stack: ScratchStack) => Effect.Effect<void, any, any>,
    opts: TestOptions | undefined,
    mode: "run" | "skip",
  ) => {
    // Captured at registration (module evaluation during collection) — the
    // AsyncLocalStorage file context is gone by the time the body runs.
    const file = currentFile();
    registerTest({
      name,
      mode,
      exclusive: exclusiveOf(opts),
      retry: retryOf(opts),
      timeout: timeoutOf(opts),
      body: mode === "skip" ? undefined : () => wrapProvider(name, fn, file),
    });
  };

  const provider = ((name, fn, opts) => {
    addProvider(name, fn, opts, "run");
  }) as ProviderFn;
  provider.skip = (name, fn, opts) => addProvider(name, fn, opts, "skip");
  provider.skipIf = (condition) => (name, fn, opts) =>
    addProvider(name, fn, opts, condition ? "skip" : "run");
  test.provider = provider;

  const beforeAll: BeforeAllFn = <A>(
    eff: TestEffect<A>,
    hookOptions?: TestOptions,
  ) => {
    let result: A;
    registerHook("beforeAll", {
      body: () =>
        wrap(eff).pipe(
          Effect.map((value) => {
            result = value;
          }),
        ),
      timeout: timeoutOf(hookOptions) ?? DEFAULT_TIMEOUT,
      exclusive: exclusiveOf(hookOptions),
    });
    return Effect.sync(() => result);
  };

  const beforeEach: BeforeEachFn = (eff, hookOptions) => {
    registerHook("beforeEach", {
      body: () => wrap(eff),
      timeout: timeoutOf(hookOptions),
    });
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
    registerHook("afterEach", {
      body: () => wrap(eff),
      timeout: timeoutOf(hookOptions),
    });
  };

  // `destroy(Stack)` needs the dev sidecar alive so it can call `sidecar.stop`
  // for each worker. We close the shared scope only AFTER destroy completes.
  // `Scope.close` on an already-closed scope is a no-op, so it's safe for both
  // the destroy wrapper AND the fallback cleanup hook below to call it.
  const closeScope = Effect.suspend(() =>
    Scope.close(sharedScope, Exit.void),
  ).pipe(Effect.ignore);

  // Fallback cleanup: if the user never calls `destroy(Stack)` (e.g.
  // `NO_DESTROY=1`), nothing else closes the shared scope and the sidecar
  // child process leaks past the test run. Register an `afterAll` that
  // closes it (and the RPC sidecar, which lives in its own scope so that
  // mid-file `destroy(Stack)` calls can't kill it for later tests). We defer
  // registration to a microtask so it runs AFTER any user-registered
  // `afterAll` (including `destroy(Stack)`); the runner executes afterAll
  // hooks in registration order, and file collection flushes microtasks
  // before sealing the file's suite tree. (Files are collected in parallel,
  // but the microtask carries the AsyncLocalStorage context of this file's
  // import, so the hook lands on the right suite.)
  const closeAll = sidecar
    ? Effect.andThen(closeScope, sidecar.close)
    : closeScope;
  queueMicrotask(() => {
    registerHook("afterAll", {
      body: () => closeAll,
      timeout: DEFAULT_TIMEOUT,
    });
  });

  return {
    test,
    beforeAll,
    beforeEach,
    afterAll,
    afterEach,
    deploy: (stack, callOpts) =>
      Core.deploy(options, stack, { ...callOpts, scope: sharedScope }),
    destroy: (stack, callOpts) =>
      Core.destroy(options, stack, { ...callOpts, scope: sharedScope }).pipe(
        Effect.ensuring(closeScope),
      ),
  };
};

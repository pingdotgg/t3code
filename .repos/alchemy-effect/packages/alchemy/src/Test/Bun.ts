import bun from "bun:test";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Scope from "effect/Scope";
import type { HookOptions } from "node:test";

import type { AlchemyContext } from "../AlchemyContext.ts";
import type { CompiledStack } from "../Stack.ts";
import type { Stage } from "../Stage.ts";
import * as Core from "./Core.ts";

export type MakeOptions<ROut = any> = Core.MakeOptions<ROut>;
export type ScratchStack = Core.ScratchStack;
export type TestEffect<A, R = never> = Core.TestEffect<A, R>;

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

interface TestFn {
  (name: string, eff: TestEffect<void>, options?: bun.TestOptions): void;
  skip: (
    name: string,
    eff: TestEffect<void>,
    options?: bun.TestOptions,
  ) => void;
  skipIf: (
    condition: boolean,
  ) => (name: string, eff: TestEffect<void>, options?: bun.TestOptions) => void;
  only: (
    name: string,
    eff: TestEffect<void>,
    options?: bun.TestOptions,
  ) => void;
  todo: (
    name: string,
    eff: TestEffect<void>,
    options?: bun.TestOptions,
  ) => void;
  provider: ProviderFn;
}

interface ProviderFn {
  (
    name: string,
    fn: (stack: ScratchStack) => Effect.Effect<void, any, any>,
    options?: bun.TestOptions,
  ): void;
  skip: (
    name: string,
    fn: (stack: ScratchStack) => Effect.Effect<void, any, any>,
    options?: bun.TestOptions,
  ) => void;
  skipIf: (
    condition: boolean,
  ) => (
    name: string,
    fn: (stack: ScratchStack) => Effect.Effect<void, any, any>,
    options?: bun.TestOptions,
  ) => void;
}

interface BeforeAllFn {
  <A>(eff: TestEffect<A>, options?: HookOptions): Effect.Effect<A>;
}

interface BeforeEachFn {
  (eff: TestEffect<void>, options?: HookOptions): void;
}

interface AfterAllFn {
  (eff: TestEffect<any>, options?: HookOptions): void;
  skipIf: (
    predicate: boolean,
  ) => (eff: TestEffect<any>, options?: HookOptions) => void;
}

interface AfterEachFn {
  (eff: TestEffect<void>, options?: HookOptions): void;
}

const DEFAULT_HOOK_TIMEOUT: HookOptions = { timeout: 120_000 };

/**
 * Build the per-file test API. Configure providers / state once at the top of
 * the test file:
 *
 * ```ts
 * import * as Test from "alchemy/Test/Bun";
 * import * as Cloudflare from "alchemy/Cloudflare";
 *
 * const { test, deploy, destroy, beforeAll, afterAll } = Test.make({
 *   providers: Cloudflare.providers(),
 *   state: Cloudflare.state(),
 * });
 * ```
 */
export const make = <ROut = any>(options: MakeOptions<ROut>): TestApi => {
  // Single scope shared across `beforeAll`, every `test`, and `afterAll`.
  // Scoped resources in dev mode (the Cloudflare sidecar process and its
  // workerd children) must outlive a single `Effect.runPromise` boundary,
  // otherwise the proxy is killed the moment `beforeAll(deploy(Stack))`
  // resolves and every later `HttpClient.get(workerUrl)` hits a dead port.
  // The scope is closed by `destroy(...)` (or never — the next test run
  // reclaims any leaked sidecar via the lock file).
  const sharedScope = Scope.makeUnsafe("sequential");
  const runEff = <A>(eff: TestEffect<A>) => Core.run(eff, options, sharedScope);

  const test = ((name, eff, opts) => {
    bun.test(name, () => runEff(eff), opts);
  }) as TestFn;

  test.skip = (name, eff, opts) => {
    bun.test.skip(name, () => runEff(eff), opts);
  };
  test.skipIf = (condition) => (name, eff, opts) => {
    bun.test.skipIf(condition)(name, () => runEff(eff), opts);
  };
  test.only = (name, eff, opts) => {
    bun.test.only(name, () => runEff(eff), opts);
  };
  test.todo = (name, eff, opts) => {
    bun.test.todo(name, () => runEff(eff), opts);
  };

  const runProvider = (
    name: string,
    fn: (stack: ScratchStack) => Effect.Effect<void, any, any>,
  ) => {
    const scratch = Core.scratchStack(options, name);
    return Core.run(
      Core.withProviders(fn(scratch), options, scratch.name),
      { ...options, state: scratch.state },
      sharedScope,
    );
  };

  const provider = ((name, fn, opts) => {
    bun.test(name, () => runProvider(name, fn), opts);
  }) as ProviderFn;
  provider.skip = (name, fn, opts) => {
    bun.test.skip(name, () => runProvider(name, fn), opts);
  };
  provider.skipIf = (condition) => (name, fn, opts) => {
    bun.test.skipIf(condition)(name, () => runProvider(name, fn), opts);
  };
  test.provider = provider;

  const beforeAll: BeforeAllFn = <A>(
    eff: TestEffect<A>,
    hookOptions?: HookOptions,
  ) => {
    let result: A;
    bun.beforeAll(
      () => runEff(eff).then((v) => (result = v)),
      hookOptions ?? DEFAULT_HOOK_TIMEOUT,
    );
    return Effect.sync(() => result);
  };

  const beforeEach: BeforeEachFn = (eff, hookOptions) => {
    bun.beforeEach(() => runEff(eff), hookOptions);
  };

  const afterAll = ((eff, hookOptions) => {
    bun.afterAll(() => runEff(eff), hookOptions ?? DEFAULT_HOOK_TIMEOUT);
  }) as AfterAllFn;
  afterAll.skipIf = (predicate) => (eff, hookOptions) => {
    if (predicate) return;
    bun.afterAll(() => runEff(eff), hookOptions ?? DEFAULT_HOOK_TIMEOUT);
  };

  const afterEach: AfterEachFn = (eff, hookOptions) => {
    bun.afterEach(() => runEff(eff), hookOptions);
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
  // child process leaks past the test process. Register an `afterAll` that
  // closes it. We defer registration to a microtask so it runs AFTER any
  // user-registered `afterAll` (including `destroy(Stack)`); bun runs
  // afterAll hooks in registration order.
  queueMicrotask(() => {
    bun.afterAll(() => Effect.runPromise(closeScope), DEFAULT_HOOK_TIMEOUT);
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

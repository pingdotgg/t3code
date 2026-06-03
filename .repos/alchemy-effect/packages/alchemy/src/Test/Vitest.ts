import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Scope from "effect/Scope";
import {
  afterAll as vitestAfterAll,
  afterEach as vitestAfterEach,
  beforeAll as vitestBeforeAll,
  beforeEach as vitestBeforeEach,
} from "vitest";

import type { AlchemyContext } from "../AlchemyContext.ts";
import type { CompiledStack } from "../Stack.ts";
import type { Stage } from "../Stage.ts";
import * as Core from "./Core.ts";

export type MakeOptions<ROut = any> = Core.MakeOptions<ROut>;
export type ScratchStack = Core.ScratchStack;
export type TestEffect<A, R = never> = Core.TestEffect<A, R>;

type TestOptions = number | { timeout?: number };

const timeoutOf = (opts: TestOptions | undefined): number | undefined =>
  typeof opts === "number" ? opts : opts?.timeout;

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
 * Build the per-file test API. See {@link "./Bun.ts"} for the same shape
 * over `bun:test`. Vitest variant uses `@effect/vitest`'s `it.live` so
 * Effect-aware tests stay first-class.
 */
export const make = <ROut = any>(options: MakeOptions<ROut>): TestApi => {
  // See `Test/Bun.ts` for the rationale: the dev sidecar must outlive a
  // single `runPromise` boundary, so all hooks share one scope that's only
  // closed after `destroy(...)` runs.
  const sharedScope = Scope.makeUnsafe("sequential");
  const wrap = <A>(eff: TestEffect<A>) =>
    Core.toEffect(eff, options, sharedScope);
  const runEff = <A>(eff: TestEffect<A>) => Core.run(eff, options, sharedScope);

  const test = ((name, eff, opts) => {
    it.live(name, () => wrap(eff), timeoutOf(opts));
  }) as TestFn;

  test.skip = (name, _eff, opts) => {
    it.skip(name, () => {}, timeoutOf(opts));
  };
  test.skipIf = (condition) => (name, eff, opts) => {
    if (condition) {
      it.skip(name, () => {}, timeoutOf(opts));
    } else {
      it.live(name, () => wrap(eff), timeoutOf(opts));
    }
  };
  test.only = (name, eff, opts) => {
    it.only(name, () => wrap(eff) as Effect.Effect<any>, timeoutOf(opts));
  };
  test.todo = (name, _eff, _opts) => {
    it.todo(name);
  };

  const wrapProvider = (
    name: string,
    fn: (stack: ScratchStack) => Effect.Effect<void, any, any>,
  ) => {
    const scratch = Core.scratchStack(options, name);
    return Core.toEffect(
      Core.withProviders(fn(scratch), options, scratch.name),
      { ...options, state: scratch.state },
      sharedScope,
    );
  };

  const provider = ((name, fn, opts) => {
    it.live(name, () => wrapProvider(name, fn), timeoutOf(opts));
  }) as ProviderFn;
  provider.skip = (name, _fn, opts) => {
    it.skip(name, () => {}, timeoutOf(opts));
  };
  provider.skipIf = (condition) => (name, fn, opts) => {
    if (condition) {
      it.skip(name, () => {}, timeoutOf(opts));
    } else {
      it.live(name, () => wrapProvider(name, fn), timeoutOf(opts));
    }
  };
  test.provider = provider;

  const beforeAll: BeforeAllFn = <A>(
    eff: TestEffect<A>,
    hookOptions?: TestOptions,
  ) => {
    let result: A;
    vitestBeforeAll(
      () => runEff(eff).then((v) => (result = v)),
      timeoutOf(hookOptions) ?? DEFAULT_TIMEOUT,
    );
    return Effect.sync(() => result);
  };

  const beforeEach: BeforeEachFn = (eff, hookOptions) => {
    vitestBeforeEach(() => runEff(eff), timeoutOf(hookOptions));
  };

  const afterAll = ((eff, hookOptions) => {
    vitestAfterAll(
      () => runEff(eff),
      timeoutOf(hookOptions) ?? DEFAULT_TIMEOUT,
    );
  }) as AfterAllFn;
  afterAll.skipIf = (predicate) => (eff, hookOptions) => {
    if (predicate) return;
    vitestAfterAll(
      () => runEff(eff),
      timeoutOf(hookOptions) ?? DEFAULT_TIMEOUT,
    );
  };

  const afterEach: AfterEachFn = (eff, hookOptions) => {
    vitestAfterEach(() => runEff(eff), timeoutOf(hookOptions));
  };

  // `destroy(Stack)` needs the dev sidecar alive so it can call `sidecar.stop`.
  // `Scope.close` on an already-closed scope is a no-op, so the destroy
  // wrapper AND the fallback cleanup hook below can both call it safely.
  const closeScope = Effect.suspend(() =>
    Scope.close(sharedScope, Exit.void),
  ).pipe(Effect.ignore);

  // Fallback cleanup: if the user never calls `destroy(Stack)` (e.g.
  // `NO_DESTROY=1`), nothing else closes the shared scope and the sidecar
  // child process leaks past the test process. Register an `afterAll` that
  // closes it. We defer registration to a microtask so it runs AFTER any
  // user-registered `afterAll` (including `destroy(Stack)`); vitest runs
  // afterAll hooks in registration order.
  queueMicrotask(() => {
    vitestAfterAll(() => Effect.runPromise(closeScope), DEFAULT_TIMEOUT);
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

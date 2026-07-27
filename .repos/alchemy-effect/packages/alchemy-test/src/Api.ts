/**
 * The vitest-compatible registration API: `describe`, `it`/`test`, hooks and
 * `layer`. Registration builds the {@link Model} tree; execution is the
 * runner's job. Everything is Effect-first — plain-function tests are wrapped
 * into Effects at registration time.
 */
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as TestClock from "effect/testing/TestClock";
import * as TestConsole from "effect/testing/TestConsole";

import type { Hook, Mode, TestBody } from "./Model.ts";
import { makeSuite } from "./Model.ts";
import { currentSuite, withSuite } from "./Registry.ts";

// ---------------------------------------------------------------------------
// Shared option handling (vitest accepts `number | { timeout?: number, ... }`)
// ---------------------------------------------------------------------------

export type TestOptions =
  | number
  | {
      readonly timeout?: number;
      readonly retry?: number;
      readonly repeats?: number;
      /**
       * Run this test with the whole-process write lock — no other test in
       * the run executes concurrently with it. Use for tests that mutate
       * process-global state (e.g. `process.env.PATH`): the runner executes
       * everything in ONE bun process, so such mutations are visible to every
       * other running test.
       */
      readonly exclusive?: boolean;
    };

export const timeoutOf = (options?: TestOptions): number | undefined =>
  typeof options === "number" ? options : options?.timeout;

export const retryOf = (options?: TestOptions): number | undefined =>
  typeof options === "object" && options !== null ? options.retry : undefined;

export const exclusiveOf = (options?: TestOptions): boolean =>
  typeof options === "object" && options !== null && options.exclusive === true;

// ---------------------------------------------------------------------------
// describe
// ---------------------------------------------------------------------------

type DescribeBody = (() => void) | undefined;

export interface DescribeOptions {
  readonly concurrent?: boolean;
  readonly sequential?: boolean;
  readonly timeout?: number;
}

export interface DescribeFn {
  (
    name: string | (() => void),
    body?: DescribeBody | DescribeOptions | number,
    bodyOrTimeout?: DescribeBody | number,
  ): void;
  readonly sequential: DescribeFn;
  readonly concurrent: DescribeFn;
  readonly skip: DescribeFn;
  readonly only: DescribeFn;
  readonly todo: DescribeFn;
  skipIf(condition: unknown): DescribeFn;
  runIf(condition: unknown): DescribeFn;
  each<T>(
    cases: ReadonlyArray<T>,
  ): (name: string, fn: (args: T) => void, options?: TestOptions) => void;
}

interface DescribeConfig {
  readonly mode: Mode;
  readonly sequential: boolean;
}

const makeDescribe = (config: DescribeConfig): DescribeFn => {
  const fn = (
    nameOrBody: string | (() => void),
    second?: DescribeBody | DescribeOptions | number,
    third?: DescribeBody | number,
  ): void => {
    // Normalize the vitest signatures:
    //   describe(name, body)
    //   describe(name, body, timeout)
    //   describe(name, options, body)
    //   describe(body)                    (via describe.skipIf(...)(() => {}))
    let name: string;
    let body: DescribeBody;
    let sequential = config.sequential;
    if (typeof nameOrBody === "function") {
      name = "";
      body = nameOrBody;
    } else {
      name = nameOrBody;
      if (typeof second === "function") {
        body = second;
      } else if (typeof second === "object" && second !== null) {
        if (second.concurrent === true || second.sequential === false) {
          sequential = false;
        } else if (second.concurrent === false || second.sequential === true) {
          sequential = true;
        }
        body = typeof third === "function" ? third : undefined;
      } else {
        body = typeof third === "function" ? third : undefined;
      }
    }
    const parent = currentSuite();
    const suite = makeSuite(name, parent, config.mode);
    suite.sequential = sequential;
    parent.children.push(suite);
    // `describe.skip` still collects its children (they're reported as
    // skipped, matching vitest); only `todo` suites skip collection.
    if (body !== undefined && config.mode !== "todo") {
      withSuite(suite, body);
    }
  };
  const withMethods = Object.assign(fn, {
    each:
      <T>(cases: ReadonlyArray<T>) =>
      (name: string, eachBody: (args: T) => void, _options?: TestOptions) => {
        cases.forEach((args, index) => {
          fn(formatEachName(name, args, index), () => eachBody(args));
        });
      },
    skipIf: (condition: unknown) =>
      makeDescribe(condition ? { ...config, mode: "skip" } : config),
    runIf: (condition: unknown) =>
      makeDescribe(condition ? config : { ...config, mode: "skip" }),
  });
  // Lazy getters — Object.assign would evaluate them eagerly and recurse
  // forever (each modifier constructs another DescribeFn).
  Object.defineProperties(withMethods, {
    sequential: { get: () => makeDescribe({ ...config, sequential: true }) },
    concurrent: { get: () => makeDescribe({ ...config, sequential: false }) },
    skip: { get: () => makeDescribe({ ...config, mode: "skip" }) },
    only: { get: () => makeDescribe({ ...config, mode: "only" }) },
    todo: { get: () => makeDescribe({ ...config, mode: "todo" }) },
  });
  return withMethods as DescribeFn;
};

export const describe: DescribeFn = makeDescribe({
  mode: "run",
  sequential: true,
});

// ---------------------------------------------------------------------------
// Test registration primitives
// ---------------------------------------------------------------------------

export interface RegisterTestOptions {
  readonly name: string;
  readonly mode: Mode;
  readonly fails?: boolean;
  readonly exclusive?: boolean;
  readonly retry?: number | undefined;
  readonly timeout?: number | undefined;
  readonly body: TestBody | undefined;
}

/** Low-level test registration — used by adapters (e.g. alchemy Test.make). */
export const registerTest = (options: RegisterTestOptions): void => {
  const parent = currentSuite();
  parent.children.push({
    type: "test",
    name: options.name,
    mode: options.mode,
    fails: options.fails ?? false,
    exclusive: options.exclusive ?? false,
    retry: options.retry,
    timeout: options.timeout,
    body: options.body,
    parent,
  });
};

/** Wrap a plain (sync or async) test function into a self-contained Effect. */
const fromFn =
  (fn: (ctx: TestContext) => unknown): TestBody =>
  () =>
    Effect.promise(async () => {
      await fn(emptyContext);
    });

/** Minimal stand-in for vitest's TestContext (rarely used by our tests). */
export interface TestContext {
  readonly signal?: AbortSignal;
}

const emptyContext: TestContext = {};

// ---------------------------------------------------------------------------
// Effect testers (it.effect / it.live)
// ---------------------------------------------------------------------------

/**
 * The environment `it.effect` provides, matching @effect/vitest: a TestClock
 * and a TestConsole on top of a per-test Scope.
 */
const TestEnv = Layer.mergeAll(TestConsole.layer, TestClock.layer());

export type EffectTestFunction<R> = (
  ctx: TestContext,
) => Effect.Effect<unknown, unknown, R>;

export interface Tester<R> {
  (name: string, self: EffectTestFunction<R>, options?: TestOptions): void;
  skip(name: string, self: EffectTestFunction<R>, options?: TestOptions): void;
  skipIf(
    condition: unknown,
  ): (name: string, self: EffectTestFunction<R>, options?: TestOptions) => void;
  runIf(
    condition: unknown,
  ): (name: string, self: EffectTestFunction<R>, options?: TestOptions) => void;
  only(name: string, self: EffectTestFunction<R>, options?: TestOptions): void;
  fails(name: string, self: EffectTestFunction<R>, options?: TestOptions): void;
  each<T>(
    cases: ReadonlyArray<T>,
  ): (
    name: string,
    self: (args: T) => Effect.Effect<unknown, unknown, R>,
    options?: TestOptions,
  ) => void;
}

export const makeTester = <R>(
  mapEffect: (
    self: Effect.Effect<unknown, unknown, R>,
  ) => Effect.Effect<unknown, unknown, never>,
): Tester<R> => {
  const register = (
    name: string,
    self: EffectTestFunction<R>,
    options: TestOptions | undefined,
    overrides?: Partial<RegisterTestOptions>,
  ) =>
    registerTest({
      name,
      mode: "run",
      timeout: timeoutOf(options),
      retry: retryOf(options),
      exclusive: exclusiveOf(options),
      body: () => mapEffect(Effect.suspend(() => self(emptyContext))),
      ...overrides,
    });

  const fn = ((name, self, options) =>
    register(name, self, options)) as Tester<R>;
  return Object.assign(fn, {
    skip: (name: string, self: EffectTestFunction<R>, options?: TestOptions) =>
      register(name, self, options, { mode: "skip" }),
    skipIf:
      (condition: unknown) =>
      (name: string, self: EffectTestFunction<R>, options?: TestOptions) =>
        register(name, self, options, { mode: condition ? "skip" : "run" }),
    runIf:
      (condition: unknown) =>
      (name: string, self: EffectTestFunction<R>, options?: TestOptions) =>
        register(name, self, options, { mode: condition ? "run" : "skip" }),
    only: (name: string, self: EffectTestFunction<R>, options?: TestOptions) =>
      register(name, self, options, { mode: "only" }),
    fails: (name: string, self: EffectTestFunction<R>, options?: TestOptions) =>
      register(name, self, options, { fails: true }),
    each:
      <T>(cases: ReadonlyArray<T>) =>
      (
        name: string,
        self: (args: T) => Effect.Effect<unknown, unknown, R>,
        options?: TestOptions,
      ) => {
        cases.forEach((args, index) => {
          register(
            formatEachName(name, args, index),
            () => self(args),
            options,
          );
        });
      },
  });
};

const formatEachName = (name: string, args: unknown, index: number): string => {
  let out = name;
  // `$prop` templating (vitest): "Container (dev: $dev)"
  if (out.includes("$") && typeof args === "object" && args !== null) {
    out = out.replace(/\$([a-zA-Z_$][\w.$]*)/g, (match, path: string) => {
      const value = path
        .split(".")
        .reduce<unknown>(
          (acc, key) =>
            acc !== null && typeof acc === "object"
              ? (acc as Record<string, unknown>)[key]
              : undefined,
          args,
        );
      return value === undefined ? match : String(value);
    });
  }
  // printf-style templating: "adds %s"
  if (out.includes("%")) {
    out = out.replace(/%[sdifjo#]/g, () =>
      typeof args === "object" ? JSON.stringify(args) : String(args),
    );
  }
  return out === name ? `${name} [${index}]` : out;
};

// ---------------------------------------------------------------------------
// it / test
// ---------------------------------------------------------------------------

export interface TestFn {
  (
    name: string,
    fn?: (ctx: TestContext) => unknown,
    options?: TestOptions,
  ): void;
  skip(
    name: string,
    fn?: (ctx: TestContext) => unknown,
    options?: TestOptions,
  ): void;
  only(
    name: string,
    fn?: (ctx: TestContext) => unknown,
    options?: TestOptions,
  ): void;
  todo(
    name: string,
    fn?: (ctx: TestContext) => unknown,
    options?: TestOptions,
  ): void;
  fails(
    name: string,
    fn?: (ctx: TestContext) => unknown,
    options?: TestOptions,
  ): void;
  skipIf(
    condition: unknown,
  ): (
    name: string,
    fn?: (ctx: TestContext) => unknown,
    options?: TestOptions,
  ) => void;
  runIf(
    condition: unknown,
  ): (
    name: string,
    fn?: (ctx: TestContext) => unknown,
    options?: TestOptions,
  ) => void;
  each<T>(
    cases: ReadonlyArray<T>,
  ): (name: string, fn: (args: T) => unknown, options?: TestOptions) => void;
  /** Effect tester with TestClock + TestConsole (matches @effect/vitest). */
  readonly effect: Tester<
    Scope.Scope | TestClock.TestClock | TestConsole.TestConsole
  >;
  /** Effect tester against the live environment (scope only). */
  readonly live: Tester<Scope.Scope>;
}

const registerFnTest = (
  name: string,
  fn: ((ctx: TestContext) => unknown) | undefined,
  options: TestOptions | undefined,
  mode: Mode,
  fails = false,
): void =>
  registerTest({
    name,
    mode: fn === undefined ? "todo" : mode,
    fails,
    timeout: timeoutOf(options),
    retry: retryOf(options),
    exclusive: exclusiveOf(options),
    body: fn === undefined ? undefined : fromFn(fn),
  });

const makeTestFn = (): TestFn => {
  const fn = ((name, body, options) =>
    registerFnTest(name, body, options, "run")) as TestFn;
  return Object.assign(fn, {
    skip: (
      name: string,
      body?: (ctx: TestContext) => unknown,
      options?: TestOptions,
    ) => registerFnTest(name, body, options, "skip"),
    only: (
      name: string,
      body?: (ctx: TestContext) => unknown,
      options?: TestOptions,
    ) => registerFnTest(name, body, options, "only"),
    todo: (
      name: string,
      body?: (ctx: TestContext) => unknown,
      options?: TestOptions,
    ) => registerFnTest(name, body, options, "todo"),
    fails: (
      name: string,
      body?: (ctx: TestContext) => unknown,
      options?: TestOptions,
    ) => registerFnTest(name, body, options, "run", true),
    skipIf:
      (condition: unknown) =>
      (
        name: string,
        body?: (ctx: TestContext) => unknown,
        options?: TestOptions,
      ) =>
        registerFnTest(name, body, options, condition ? "skip" : "run"),
    runIf:
      (condition: unknown) =>
      (
        name: string,
        body?: (ctx: TestContext) => unknown,
        options?: TestOptions,
      ) =>
        registerFnTest(name, body, options, condition ? "run" : "skip"),
    each:
      <T>(cases: ReadonlyArray<T>) =>
      (name: string, body: (args: T) => unknown, options?: TestOptions) => {
        cases.forEach((args, index) => {
          registerFnTest(
            formatEachName(name, args, index),
            () => body(args),
            options,
            "run",
          );
        });
      },
    effect: makeTester<
      Scope.Scope | TestClock.TestClock | TestConsole.TestConsole
    >(
      (self) =>
        self.pipe(Effect.scoped, Effect.provide(TestEnv)) as Effect.Effect<
          unknown,
          unknown,
          never
        >,
    ),
    live: makeTester<Scope.Scope>((self) => Effect.scoped(self)),
  });
};

export const it: TestFn = makeTestFn();
export const test: TestFn = it;

// ---------------------------------------------------------------------------
// Hooks
// ---------------------------------------------------------------------------

export type HookKind = "beforeAll" | "afterAll" | "beforeEach" | "afterEach";

/** Low-level hook registration with an Effect body — used by adapters. */
export const registerHook = (kind: HookKind, hook: Hook): void => {
  currentSuite()[kind].push(hook);
};

const hookFromFn =
  (fn: () => unknown): Hook["body"] =>
  () =>
    Effect.promise(async () => {
      await fn();
    });

export const beforeAll = (fn: () => unknown, timeout?: number): void =>
  registerHook("beforeAll", { body: hookFromFn(fn), timeout });
export const afterAll = (fn: () => unknown, timeout?: number): void =>
  registerHook("afterAll", { body: hookFromFn(fn), timeout });
export const beforeEach = (fn: () => unknown, timeout?: number): void =>
  registerHook("beforeEach", { body: hookFromFn(fn), timeout });
export const afterEach = (fn: () => unknown, timeout?: number): void =>
  registerHook("afterEach", { body: hookFromFn(fn), timeout });

// ---------------------------------------------------------------------------
// layer — share a Layer across the tests of a block (@effect/vitest parity)
// ---------------------------------------------------------------------------

export interface LayerMethods<R> {
  effect: Tester<
    R | Scope.Scope | TestClock.TestClock | TestConsole.TestConsole
  >;
  layer<R2, E2>(
    nested: Layer.Layer<R2, E2, R>,
    options?: { readonly timeout?: number },
  ): {
    (f: (it: LayerMethods<R | R2>) => void): void;
    (name: string, f: (it: LayerMethods<R | R2>) => void): void;
  };
}

export const layer =
  <R, E>(
    layer_: Layer.Layer<R, E>,
    options?: {
      readonly memoMap?: Layer.MemoMap;
      readonly timeout?: number;
      readonly excludeTestServices?: boolean;
    },
  ): {
    (f: (it: LayerMethods<R>) => void): void;
    (name: string, f: (it: LayerMethods<R>) => void): void;
  } =>
  (
    ...args:
      | [name: string, f: (it: LayerMethods<R>) => void]
      | [f: (it: LayerMethods<R>) => void]
  ): void => {
    const excludeTestServices = options?.excludeTestServices ?? false;
    const withTestEnv = excludeTestServices
      ? (layer_ as Layer.Layer<R, E>)
      : Layer.provideMerge(layer_, TestEnv);
    const memoMap = options?.memoMap ?? Effect.runSync(Layer.makeMemoMap);
    const scope = Scope.makeUnsafe();
    const contextEffect = Layer.buildWithMemoMap(
      withTestEnv,
      memoMap,
      scope,
    ).pipe(Effect.orDie, Effect.cached, Effect.runSync);

    const makeMethods = (): LayerMethods<R> => ({
      effect: makeTester<
        R | Scope.Scope | TestClock.TestClock | TestConsole.TestConsole
      >(
        (self) =>
          Effect.flatMap(contextEffect, (context) =>
            self.pipe(Effect.scoped, Effect.provide(context)),
          ) as Effect.Effect<unknown, unknown, never>,
      ),
      layer: (nested, nestedOptions) =>
        layer(
          Layer.provideMerge(nested, withTestEnv) as Layer.Layer<any, any>,
          {
            ...nestedOptions,
            memoMap: Layer.forkMemoMapUnsafe(memoMap),
            excludeTestServices,
          },
        ) as any,
    });

    const register = (): void => {
      registerHook("afterAll", {
        body: () => Scope.close(scope, Exit.void),
        timeout: options?.timeout,
      });
      const f = (args.length === 1 ? args[0] : args[1]) as (
        it: LayerMethods<R>,
      ) => void;
      f(makeMethods());
    };

    if (args.length === 2) {
      describe(args[0], register);
    } else {
      register();
    }
  };

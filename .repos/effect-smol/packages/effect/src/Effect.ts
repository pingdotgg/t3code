/**
 * `Effect` is the core data type for describing programs that may perform
 * synchronous or asynchronous work, fail with typed errors, require services,
 * acquire resources, or run concurrently. An `Effect<A, E, R>` is lazy: creating
 * one describes a workflow, and running it executes that workflow.
 *
 * **Mental model**
 *
 * - `A` is the success value, `E` is the expected failure type, and `R` is the
 *   context of services required to run
 * - Effects are immutable descriptions, not promises; composition with
 *   {@link map}, {@link flatMap}, {@link zip}, or {@link gen} builds a larger
 *   description
 * - Failures in `E` are part of the type signature and can be handled with
 *   {@link match}, {@link matchEffect}, {@link catchTag}, or {@link catchTags}
 * - Requirements in `R` are satisfied before running, usually with
 *   {@link provide}, {@link provideService}, or layers
 * - Fibers are lightweight executions of effects and are used by concurrency
 *   operators such as {@link all}, {@link race}, {@link forkScoped}, and
 *   {@link forkDetach}
 *
 * **Common tasks**
 *
 * - Create values and failures: {@link succeed}, {@link fail}, {@link failSync}
 * - Wrap promise-producing code: {@link tryPromise}
 * - Sequence workflows: {@link gen}, {@link flatMap}, {@link map}, {@link tap}
 * - Handle errors: {@link match}, {@link matchEffect}, {@link catchTag},
 *   {@link catchTags}
 * - Run effects at the edge of an application: {@link runPromise},
 *   {@link runSync}, {@link runFork}
 * - Work with time and interruption: {@link sleep}, {@link timeout},
 *   {@link retry}
 * - Manage resources: {@link acquireRelease}, {@link scoped},
 *   {@link scopedWith}
 * - Provide services: {@link provide}, {@link provideContext},
 *   {@link provideService}, {@link provideServiceEffect}
 *
 * **Gotchas**
 *
 * - Effects do nothing until run by a runtime function such as
 *   {@link runPromise}, {@link runSync}, or {@link runFork}
 * - {@link runSync} is only for effects that can complete synchronously; use
 *   {@link runPromise} for effects that may suspend asynchronously
 * - In {@link gen}, use `yield*` to compose effects; do not use `await` inside
 *   the generator
 * - The `E` type tracks expected failures, not every possible JavaScript
 *   defect such as an unchecked throw
 * - Any remaining `R` requirement must be provided before an effect can be run
 *
 * **Quickstart**
 *
 * **Example** (Composing and running a typed workflow)
 *
 * ```ts
 * import { Console, Effect } from "effect"
 *
 * const divide = (a: number, b: number) =>
 *   b === 0
 *     ? Effect.fail("divide by zero")
 *     : Effect.succeed(a / b)
 *
 * const program = Effect.gen(function*() {
 *   const result = yield* divide(10, 2)
 *   yield* Console.log(`result: ${result}`)
 *   return result
 * })
 *
 * Effect.runPromise(program).then(console.log)
 * ```
 *
 * **See also**
 *
 * - {@link gen} for generator-based sequencing
 * - {@link tryPromise} for asynchronous boundaries
 * - {@link acquireRelease} and {@link scoped} for resource safety
 * - {@link runPromise}, {@link runSync}, and {@link runFork} for execution
 *
 * @since 2.0.0
 */
import type * as Arr from "./Array.ts"
import type * as Cause from "./Cause.ts"
import type { Clock } from "./Clock.ts"
import * as Context from "./Context.ts"
import * as Duration from "./Duration.ts"
import type { ExecutionPlan } from "./ExecutionPlan.ts"
import * as Exit from "./Exit.ts"
import type { Fiber } from "./Fiber.ts"
import type * as Filter from "./Filter.ts"
import { constant, dual, type LazyArg } from "./Function.ts"
import type { TypeLambda } from "./HKT.ts"
import type { Inspectable } from "./Inspectable.ts"
import * as core from "./internal/core.ts"
import * as internal from "./internal/effect.ts"
import * as internalExecutionPlan from "./internal/executionPlan.ts"
import * as internalLayer from "./internal/layer.ts"
import * as internalRequest from "./internal/request.ts"
import * as internalSchedule from "./internal/schedule.ts"
import type * as Layer from "./Layer.ts"
import type { Logger } from "./Logger.ts"
import type { Severity } from "./LogLevel.ts"
import * as Metric from "./Metric.ts"
import type { Option } from "./Option.ts"
import type { Pipeable } from "./Pipeable.ts"
import type * as Predicate from "./Predicate.ts"
import { CurrentLogAnnotations, CurrentLogSpans } from "./References.ts"
import type * as Request from "./Request.ts"
import type { RequestResolver } from "./RequestResolver.ts"
import type * as Result from "./Result.ts"
import type { Schedule } from "./Schedule.ts"
import type { Scheduler } from "./Scheduler.ts"
import type { Scope } from "./Scope.ts"
import type {
  AnySpan,
  ParentSpan,
  Span,
  SpanLink,
  SpanOptions,
  SpanOptionsNoTrace,
  TraceOptions,
  Tracer
} from "./Tracer.ts"
import type { TxRef } from "./TxRef.ts"
import type {
  Concurrency,
  Covariant,
  EqualsWith,
  ExcludeReason,
  ExcludeTag,
  ExtractReason,
  ExtractTag,
  NarrowReason,
  NoInfer,
  OmitReason,
  ReasonOf,
  ReasonTags,
  Simplify,
  Tags,
  unassigned
} from "./Types.ts"
import type * as Unify from "./Unify.ts"
import { internalCall } from "./Utils.ts"

/**
 * Type-level identifier for `Effect` values.
 *
 * @category type IDs
 * @since 4.0.0
 */
export type TypeId = "~effect/Effect"

/**
 * Runtime identifier used to recognize `Effect` values.
 *
 * @category type IDs
 * @since 4.0.0
 */
export const TypeId: TypeId = core.EffectTypeId

/**
 * The `Effect` interface defines a value that lazily describes a workflow or
 * job. The workflow requires some context `R`, and may fail with an error of
 * type `E`, or succeed with a value of type `A`.
 *
 * **When to use**
 *
 * Use when you need to represent a lazy, composable workflow that can require
 * services, fail with a typed error, or succeed with a typed value.
 *
 * **Details**
 *
 * `Effect` values model resourceful interaction with the outside world,
 * including synchronous, asynchronous, concurrent, and parallel interaction.
 * They use a fiber-based concurrency model, with built-in support for
 * scheduling, fine-grained interruption, structured concurrency, and high
 * scalability.
 *
 * To run an `Effect` value, you need a `Runtime`, which is a type that is
 * capable of executing `Effect` values.
 *
 * @category models
 * @since 2.0.0
 */
export interface Effect<out A, out E = never, out R = never> extends Pipeable, Inspectable {
  readonly [TypeId]: Variance<A, E, R>
  [Symbol.iterator](): EffectIterator<Effect<A, E, R>>
  [Unify.typeSymbol]?: unknown
  [Unify.unifySymbol]?: EffectUnify<this>
  [Unify.ignoreSymbol]?: {}
}

/**
 * Type-level unification support for `Effect` values.
 *
 * @category models
 * @since 2.0.0
 */
export interface EffectUnify<A extends { [Unify.typeSymbol]?: any }> {
  Effect?: () => A[Unify.typeSymbol] extends
    | Effect<infer A0, infer E0, infer R0>
    | infer _ ? Effect<A0, E0, R0>
    : never
}

/**
 * Type lambda used to represent `Effect` in higher-kinded APIs.
 *
 * @category type lambdas
 * @since 2.0.0
 */
export interface EffectTypeLambda extends TypeLambda {
  readonly type: Effect<this["Target"], this["Out1"], this["Out2"]>
}

/**
 * Variance interface for Effect, encoding the type parameters' variance.
 *
 * @category models
 * @since 2.0.0
 */
export interface Variance<A, E, R> {
  _A: Covariant<A>
  _E: Covariant<E>
  _R: Covariant<R>
}

/**
 * Extracts the success type from an `Effect`.
 *
 * **When to use**
 *
 * Use to derive the value produced by an existing effect when declaring
 * reusable type aliases, service interfaces, or function signatures.
 *
 * @see {@link Error} for extracting the failure type from the same `Effect`
 * @see {@link Services} for extracting the required services from the same `Effect`
 *
 * @category models
 * @since 2.0.0
 */
export type Success<T> = T extends Effect<infer _A, infer _E, infer _R> ? _A
  : never

/**
 * Extracts the error type from an `Effect`.
 *
 * **When to use**
 *
 * Use to derive the error type from an existing `Effect` type when declaring
 * helper types, wrappers, or APIs that preserve the effect's failure channel.
 *
 * **Details**
 *
 * Non-`Effect` inputs resolve to `never`.
 *
 * @see {@link Success} for extracting the success value type instead
 * @see {@link Services} for extracting the required services type instead
 *
 * @category models
 * @since 2.0.0
 */
export type Error<T> = T extends Effect<infer _A, infer _E, infer _R> ? _E
  : never

/**
 * Extracts the required services type from an `Effect`.
 *
 * **When to use**
 *
 * Use to derive the context requirements of a generic or inferred `Effect`
 * without restating its `R` type parameter.
 *
 * @see {@link Success} for extracting the success value type instead
 * @see {@link Error} for extracting the failure type instead
 *
 * @category models
 * @since 4.0.0
 */
export type Services<T> = T extends Effect<infer _A, infer _E, infer _R> ? _R
  : never

/**
 * Checks whether a value is an `Effect`.
 *
 * **Example** (Checking whether a value is an Effect)
 *
 * ```ts
 * import { Effect } from "effect"
 *
 * console.log(Effect.isEffect(Effect.succeed(1))) // true
 * console.log(Effect.isEffect("hello")) // false
 * ```
 *
 * @category guards
 * @since 2.0.0
 */
export const isEffect: (u: unknown) => u is Effect<any, any, any> = core.isEffect

/**
 * Iterator interface for Effect generators, enabling Effect values to work with generator functions.
 *
 * **When to use**
 *
 * Use when defining or typing `[Symbol.iterator]()` for values typed as
 * `Effect`s so `yield*` can pass their success type back into `Effect.gen`.
 *
 * @see {@link gen} for writing generator-based `Effect` programs that consume this iterator protocol
 *
 * @category models
 * @since 4.0.0
 */
export interface EffectIterator<T extends Effect<any, any, any>> {
  next(
    ...args: ReadonlyArray<any>
  ): IteratorResult<T, Success<T>>
}

// ========================================================================
// Collecting
// ========================================================================

/**
 * Namespace containing type utilities for the `Effect.all` function, which handles
 * collecting multiple effects into various output structures.
 *
 * @since 2.0.0
 */
export declare namespace All {
  /**
   * Alias for any `Effect` value accepted by `Effect.all`.
   *
   * @category models
   * @since 2.0.0
   */
  export type EffectAny = Effect<any, any, any>

  /**
   * Computes the return type for `Effect.all` when collecting an iterable.
   *
   * @category models
   * @since 2.0.0
   */
  export type ReturnIterable<
    T extends Iterable<EffectAny>,
    Discard extends boolean,
    Mode extends boolean = false
  > = [T] extends [Iterable<Effect<infer A, infer E, infer R>>] ? Effect<
      Discard extends true ? void : Array<Mode extends true ? Result.Result<A, E> : A>,
      Mode extends true ? never : E,
      R
    >
    : never

  /**
   * Computes the return type for `Effect.all` when collecting a tuple.
   *
   * @category models
   * @since 2.0.0
   */
  export type ReturnTuple<
    T extends ReadonlyArray<unknown>,
    Discard extends boolean,
    Mode extends boolean = false
  > = Effect<
    Discard extends true ? void
      : T[number] extends never ? []
      : {
        -readonly [K in keyof T]: T[K] extends Effect<
          infer _A,
          infer _E,
          infer _R
        > ? Mode extends true ? Result.Result<_A, _E> : _A
          : never
      },
    Mode extends true ? never
      : T[number] extends never ? never
      : T[number] extends Effect<infer _A, infer _E, infer _R> ? _E
      : never,
    T[number] extends never ? never
      : T[number] extends Effect<infer _A, infer _E, infer _R> ? _R
      : never
  > extends infer X ? X
    : never

  /**
   * Computes the return type for `Effect.all` when collecting a record.
   *
   * @category models
   * @since 2.0.0
   */
  export type ReturnObject<T, Discard extends boolean, Mode extends boolean = false> = [T] extends [
    Record<string, EffectAny>
  ] ? Effect<
      Discard extends true ? void
        : {
          -readonly [K in keyof T]: [T[K]] extends [
            Effect<infer _A, infer _E, infer _R>
          ] ? Mode extends true ? Result.Result<_A, _E> : _A
            : never
        },
      Mode extends true ? never
        : keyof T extends never ? never
        : T[keyof T] extends Effect<infer _A, infer _E, infer _R> ? _E
        : never,
      keyof T extends never ? never
        : T[keyof T] extends Effect<infer _A, infer _E, infer _R> ? _R
        : never
    >
    : never

  /**
   * Detects whether `Effect.all` should discard collected values.
   *
   * @category models
   * @since 2.0.0
   */
  export type IsDiscard<A> = [Extract<A, { readonly discard: true }>] extends [
    never
  ] ? false
    : true

  /**
   * Detects whether `Effect.all` should collect results in `Result` mode.
   *
   * @category models
   * @since 4.0.0
   */
  export type IsResult<A> = [Extract<A, { readonly mode: "result" }>] extends [never] ? false : true

  /**
   * Computes the return type for `Effect.all` from its input and options.
   *
   * @category models
   * @since 2.0.0
   */
  export type Return<
    Arg extends Iterable<EffectAny> | Record<string, EffectAny>,
    O extends {
      readonly concurrency?: Concurrency | undefined
      readonly discard?: boolean | undefined
      readonly mode?: "default" | "result" | undefined
    }
  > = [Arg] extends [ReadonlyArray<EffectAny>] ? ReturnTuple<Arg, IsDiscard<O>, IsResult<O>>
    : [Arg] extends [Iterable<EffectAny>] ? ReturnIterable<Arg, IsDiscard<O>, IsResult<O>>
    : [Arg] extends [Record<string, EffectAny>] ? ReturnObject<Arg, IsDiscard<O>, IsResult<O>>
    : never
}

/**
 * Combines an iterable or record of effects into one effect whose success shape
 * follows the input.
 *
 * **When to use**
 *
 * Use to run a known collection of effects and collect results in the same
 * tuple, iterable, or record shape.
 *
 * **Details**
 *
 * Tuple and iterable inputs collect results in order. Record inputs collect
 * results under the same keys. By default, the combined effect fails on the
 * first failure; with concurrent execution, effects that have already started
 * may be interrupted, while effects not yet started are skipped.
 *
 * Options:
 *
 * Use `concurrency` to control sequential or concurrent execution. Use
 * `mode: "result"` to run every effect and collect each success or failure as a
 * `Result` in the same output shape. Use `discard: true` to ignore successful
 * values and return `void`.
 *
 * **Example** (Collecting tuple results in order)
 *
 * ```ts
 * import { Console, Effect } from "effect"
 *
 * const tupleOfEffects = [
 *   Effect.succeed(42).pipe(Effect.tap(Console.log)),
 *   Effect.succeed("Hello").pipe(Effect.tap(Console.log))
 * ] as const
 *
 * //      ┌─── Effect<[number, string], never, never>
 * //      ▼
 * const resultsAsTuple = Effect.all(tupleOfEffects)
 *
 * Effect.runPromise(resultsAsTuple).then(console.log)
 * // Output:
 * // 42
 * // Hello
 * // [ 42, 'Hello' ]
 * ```
 *
 * **Example** (Collecting iterable results in order)
 *
 * ```ts
 * import { Console, Effect } from "effect"
 *
 * const iterableOfEffects: Iterable<Effect.Effect<number>> = [1, 2, 3].map(
 *   (n) => Effect.succeed(n).pipe(Effect.tap(Console.log))
 * )
 *
 * //      ┌─── Effect<number[], never, never>
 * //      ▼
 * const resultsAsArray = Effect.all(iterableOfEffects)
 *
 * Effect.runPromise(resultsAsArray).then(console.log)
 * // Output:
 * // 1
 * // 2
 * // 3
 * // [ 1, 2, 3 ]
 * ```
 *
 * **Example** (Collecting struct results by key)
 *
 * ```ts
 * import { Console, Effect } from "effect"
 *
 * const structOfEffects = {
 *   a: Effect.succeed(42).pipe(Effect.tap(Console.log)),
 *   b: Effect.succeed("Hello").pipe(Effect.tap(Console.log))
 * }
 *
 * //      ┌─── Effect<{ a: number; b: string; }, never, never>
 * //      ▼
 * const resultsAsStruct = Effect.all(structOfEffects)
 *
 * Effect.runPromise(resultsAsStruct).then(console.log)
 * // Output:
 * // 42
 * // Hello
 * // { a: 42, b: 'Hello' }
 * ```
 *
 * **Example** (Collecting record results by key)
 *
 * ```ts
 * import { Console, Effect } from "effect"
 *
 * const recordOfEffects: Record<string, Effect.Effect<number>> = {
 *   key1: Effect.succeed(1).pipe(Effect.tap(Console.log)),
 *   key2: Effect.succeed(2).pipe(Effect.tap(Console.log))
 * }
 *
 * //      ┌─── Effect<{ [x: string]: number; }, never, never>
 * //      ▼
 * const resultsAsRecord = Effect.all(recordOfEffects)
 *
 * Effect.runPromise(resultsAsRecord).then(console.log)
 * // Output:
 * // 1
 * // 2
 * // { key1: 1, key2: 2 }
 * ```
 *
 * **Example** (Stopping on the first failure)
 *
 * ```ts
 * import { Console, Effect } from "effect"
 *
 * const program = Effect.all([
 *   Effect.succeed("Task1").pipe(Effect.tap(Console.log)),
 *   Effect.fail("Task2: Oh no!").pipe(Effect.tap(Console.log)),
 *   // Won't execute due to earlier failure
 *   Effect.succeed("Task3").pipe(Effect.tap(Console.log))
 * ])
 *
 * Effect.runPromiseExit(program).then(console.log)
 * // Output:
 * // Task1
 * // {
 * //   _id: 'Exit',
 * //   _tag: 'Failure',
 * //   cause: { _id: 'Cause', _tag: 'Fail', failure: 'Task2: Oh no!' }
 * // }
 * ```
 *
 * @see {@link forEach} for iterating over elements and applying an effect.
 * @category collecting
 * @since 2.0.0
 */
export const all: <
  const Arg extends
    | Iterable<Effect<any, any, any>>
    | Record<string, Effect<any, any, any>>,
  O extends {
    readonly concurrency?: Concurrency | undefined
    readonly discard?: boolean | undefined
    readonly mode?: "default" | "result" | undefined
  }
>(
  arg: Arg,
  options?: O
) => All.Return<Arg, O> = internal.all

/**
 * Applies an effectful function to each element and partitions failures and
 * successes.
 *
 * **Details**
 *
 * The returned tuple is `[excluded, satisfying]`, where:
 *
 * - `excluded` contains all failures.
 * - `satisfying` contains all successes.
 *
 * This function runs every effect and never fails. Use `concurrency` to control
 * parallelism.
 *
 * **Example** (Separating successes and failures)
 *
 * ```ts
 * import { Effect } from "effect"
 *
 * const program = Effect.partition([0, 1, 2, 3], (n) =>
 *   n % 2 === 0 ? Effect.fail(`${n} is even`) : Effect.succeed(n)
 * )
 *
 * Effect.runPromise(program).then(console.log)
 * // [ ["0 is even", "2 is even"], [1, 3] ]
 * ```
 *
 * @category collecting
 * @since 2.0.0
 */
export const partition: {
  <A, B, E, R>(
    f: (a: A, i: number) => Effect<B, E, R>,
    options?: { readonly concurrency?: Concurrency | undefined }
  ): (elements: Iterable<A>) => Effect<[excluded: Array<E>, satisfying: Array<B>], never, R>
  <A, B, E, R>(
    elements: Iterable<A>,
    f: (a: A, i: number) => Effect<B, E, R>,
    options?: { readonly concurrency?: Concurrency | undefined }
  ): Effect<[excluded: Array<E>, satisfying: Array<B>], never, R>
} = internal.partition

/**
 * Applies an effectful function to each element and accumulates all failures.
 *
 * **Details**
 *
 * This function always evaluates every element. If at least one effect fails,
 * all failures are returned as a non-empty array and successes are discarded.
 * If all effects succeed, it returns all collected successes.
 *
 * Use `discard: true` to ignore successful values while still validating all
 * elements.
 *
 * **Example** (Validating every element)
 *
 * ```ts
 * import { Effect } from "effect"
 *
 * const program = Effect.validate([0, 1, 2, 3], (n) =>
 *   n % 2 === 0 ? Effect.fail(`${n} is even`) : Effect.succeed(n)
 * )
 *
 * Effect.runPromiseExit(program).then(console.log)
 * // {
 * //   _id: 'Exit',
 * //   _tag: 'Failure',
 * //   cause: {
 * //     _id: 'Cause',
 * //     reasons: [
 * //       { _id: 'Reason', _tag: 'Fail', error: '0 is even' },
 * //       { _id: 'Reason', _tag: 'Fail', error: '2 is even' }
 * //     ]
 * //   }
 * // }
 * ```
 *
 * @category error accumulation
 * @since 2.0.0
 */
export const validate: {
  <A, B, E, R>(
    f: (a: A, i: number) => Effect<B, E, R>,
    options?: {
      readonly concurrency?: Concurrency | undefined
      readonly discard?: false | undefined
    } | undefined
  ): (elements: Iterable<A>) => Effect<Array<B>, Arr.NonEmptyArray<E>, R>
  <A, B, E, R>(
    f: (a: A, i: number) => Effect<B, E, R>,
    options: {
      readonly concurrency?: Concurrency | undefined
      readonly discard: true
    }
  ): (elements: Iterable<A>) => Effect<void, Arr.NonEmptyArray<E>, R>
  <A, B, E, R>(
    elements: Iterable<A>,
    f: (a: A, i: number) => Effect<B, E, R>,
    options?: {
      readonly concurrency?: Concurrency | undefined
      readonly discard?: false | undefined
    } | undefined
  ): Effect<Array<B>, Arr.NonEmptyArray<E>, R>
  <A, B, E, R>(
    elements: Iterable<A>,
    f: (a: A, i: number) => Effect<B, E, R>,
    options: {
      readonly concurrency?: Concurrency | undefined
      readonly discard: true
    }
  ): Effect<void, Arr.NonEmptyArray<E>, R>
} = internal.validate

/**
 * Returns the first element that satisfies an effectful predicate.
 *
 * **Details**
 *
 * The predicate receives the element and its index. Evaluation short-circuits
 * as soon as an element matches.
 *
 * **Example** (Finding the first successful match)
 *
 * ```ts
 * import { Effect } from "effect"
 *
 * const program = Effect.findFirst([1, 2, 3, 4], (n) => Effect.succeed(n > 2))
 *
 * Effect.runPromise(program).then(console.log)
 * // { _id: 'Option', _tag: 'Some', value: 3 }
 * ```
 *
 * @category collecting
 * @since 2.0.0
 */
export const findFirst: {
  <A, E, R>(
    predicate: (a: NoInfer<A>, i: number) => Effect<boolean, E, R>
  ): (elements: Iterable<A>) => Effect<Option<A>, E, R>
  <A, E, R>(
    elements: Iterable<A>,
    predicate: (a: NoInfer<A>, i: number) => Effect<boolean, E, R>
  ): Effect<Option<A>, E, R>
} = internal.findFirst

/**
 * Returns the first value that passes an effectful `FilterEffect`.
 *
 * **When to use**
 *
 * Use when you need to find the first element that satisfies an effectful
 * filter returning a `Result`, which also transforms the matching element.
 *
 * **Details**
 *
 * The filter receives the element and index. Evaluation short-circuits on the
 * first `Result.succeed` and returns the transformed value in `Option.some`.
 *
 * @see {@link findFirst} for the simpler effectful predicate-based variant
 *
 * @category collecting
 * @since 4.0.0
 */
export const findFirstFilter: {
  <A, B, X, E, R>(
    filter: (input: NoInfer<A>, i: number) => Effect<Result.Result<B, X>, E, R>
  ): (elements: Iterable<A>) => Effect<Option<B>, E, R>
  <A, B, X, E, R>(
    elements: Iterable<A>,
    filter: (input: NoInfer<A>, i: number) => Effect<Result.Result<B, X>, E, R>
  ): Effect<Option<B>, E, R>
} = internal.findFirstFilter

/**
 * Executes an effectful operation for each element in an `Iterable`.
 *
 * **When to use**
 *
 * Use to traverse an iterable with an effectful function while preserving
 * element order in the collected results.
 *
 * **Details**
 *
 * The `forEach` function applies a provided operation to each element in the
 * iterable, producing a new effect that returns an array of results.
 *
 * If any effect fails, the iteration stops immediately (short-circuiting), and
 * the error is propagated.
 *
 * Concurrency:
 *
 * The `concurrency` option controls how many operations are performed
 * concurrently. By default, the operations are performed sequentially.
 *
 * Discarding Results:
 *
 * If the `discard` option is set to `true`, the intermediate results are not
 * collected, and the final result of the operation is `void`.
 *
 * **Example** (Mapping over an iterable with effects)
 *
 * ```ts
 * import { Console, Effect } from "effect"
 *
 * const result = Effect.forEach(
 *   [1, 2, 3, 4, 5],
 *   (n, index) =>
 *     Console.log(`Currently at index ${index}`).pipe(Effect.as(n * 2))
 * )
 *
 * Effect.runPromise(result).then(console.log)
 * // Output:
 * // Currently at index 0
 * // Currently at index 1
 * // Currently at index 2
 * // Currently at index 3
 * // Currently at index 4
 * // [ 2, 4, 6, 8, 10 ]
 * ```
 *
 * **Example** (Running effects without collecting results)
 *
 * ```ts
 * import { Console, Effect } from "effect"
 *
 * // Apply effects but discard the results
 * const result = Effect.forEach(
 *   [1, 2, 3, 4, 5],
 *   (n, index) =>
 *     Console.log(`Currently at index ${index}`).pipe(Effect.as(n * 2)),
 *   { discard: true }
 * )
 *
 * Effect.runPromise(result).then(console.log)
 * // Output:
 * // Currently at index 0
 * // Currently at index 1
 * // Currently at index 2
 * // Currently at index 3
 * // Currently at index 4
 * // undefined
 * ```
 *
 * @see {@link all} for combining multiple effects into one.
 * @category collecting
 * @since 2.0.0
 */
export const forEach: {
  <B, E, R, S extends Iterable<any>, const Discard extends boolean = false>(
    f: (a: Arr.ReadonlyArray.Infer<S>, i: number) => Effect<B, E, R>,
    options?: { readonly concurrency?: Concurrency | undefined; readonly discard?: Discard | undefined } | undefined
  ): (self: S) => Effect<Discard extends false ? Arr.ReadonlyArray.With<S, B> : void, E, R>
  <B, E, R, S extends Iterable<any>, const Discard extends boolean = false>(
    self: S,
    f: (a: Arr.ReadonlyArray.Infer<S>, i: number) => Effect<B, E, R>,
    options?: { readonly concurrency?: Concurrency | undefined; readonly discard?: Discard | undefined } | undefined
  ): Effect<Discard extends false ? Arr.ReadonlyArray.With<S, B> : void, E, R>
} = internal.forEach

/**
 * Executes a body effect repeatedly while a condition holds true.
 *
 * **Example** (Repeating an effectful loop)
 *
 * ```ts
 * import { Effect } from "effect"
 *
 * let counter = 0
 *
 * const program = Effect.whileLoop({
 *   while: () => counter < 5,
 *   body: () => Effect.sync(() => ++counter),
 *   step: (n) => console.log(`Current count: ${n}`)
 * })
 *
 * Effect.runPromise(program)
 * // Output:
 * // Current count: 1
 * // Current count: 2
 * // Current count: 3
 * // Current count: 4
 * // Current count: 5
 * ```
 *
 * @category collecting
 * @since 2.0.0
 */
export const whileLoop: <A, E, R>(options: {
  readonly while: LazyArg<boolean>
  readonly body: LazyArg<Effect<A, E, R>>
  readonly step: (a: A) => void
}) => Effect<void, E, R> = internal.whileLoop

// -----------------------------------------------------------------------------
// Creating Effects
// -----------------------------------------------------------------------------

/**
 * Creates an `Effect` that represents an asynchronous computation guaranteed to
 * succeed.
 *
 * **When to use**
 *
 * Use to convert a `Promise` into an `Effect` when the async operation is
 * guaranteed to succeed and will not reject.
 *
 * **Details**
 *
 * An optional `AbortSignal` can be provided to allow for interruption of the
 * wrapped `Promise` API.
 *
 * **Gotchas**
 *
 * The `Promise` must not reject. If it rejects, the rejection is treated as a
 * defect, not as a typed failure. Use `tryPromise` when rejection is expected.
 *
 * Interruption aborts the provided `AbortSignal`, but the underlying
 * asynchronous operation only stops if it observes that signal.
 *
 * **Example** (Wrapping a non-rejecting Promise)
 *
 * ```ts
 * import { Effect } from "effect"
 *
 * const delay = (message: string) =>
 *   Effect.promise<string>(
 *     () =>
 *       new Promise((resolve) => {
 *         setTimeout(() => {
 *           resolve(message)
 *         }, 2000)
 *       })
 *   )
 *
 * //      ┌─── Effect<string, never, never>
 * //      ▼
 * const program = delay("Async operation completed successfully!")
 * ```
 *
 * @see {@link tryPromise} for a version that can handle failures.
 * @category creating effects
 * @since 2.0.0
 */
export const promise: <A>(
  evaluate: (signal: AbortSignal) => PromiseLike<A>
) => Effect<A> = internal.promise

/**
 * Creates an `Effect` that represents an asynchronous computation that might
 * fail.
 *
 * **When to use**
 *
 * Use when you need to perform asynchronous operations that might fail, such
 * as fetching data from an API, and want thrown exceptions or rejected promises
 * captured as Effect errors.
 *
 * **Details**
 *
 * Error Handling:
 *
 * There are two ways to handle errors with `tryPromise`:
 *
 * 1. If you don't provide a `catch` function, the error is caught and the
 *    effect fails with an `UnknownError`.
 * 2. If you provide a `catch` function, the error is caught and the `catch`
 *    function maps it to an error of type `E`.
 *
 * Interruptions:
 *
 * An optional `AbortSignal` can be provided to allow for interruption of the
 * wrapped `Promise` API.
 *
 * **Example** (Wrapping a fetch request that may fail)
 *
 * ```ts
 * import { Effect } from "effect"
 *
 * const getTodo = (id: number) =>
 *   // Will catch any errors and propagate them as UnknownError
 *   Effect.tryPromise(() =>
 *     fetch(`https://jsonplaceholder.typicode.com/todos/${id}`)
 *   )
 *
 * //      ┌─── Effect<Response, UnknownError, never>
 * //      ▼
 * const program = getTodo(1)
 * ```
 *
 * **Example** (Mapping Promise rejections to a tagged error)
 *
 * ```ts
 * import { Data, Effect } from "effect"
 *
 * class TodoFetchError extends Data.TaggedError("TodoFetchError")<{ readonly cause: unknown }> {}
 *
 * const getTodo = (id: number) =>
 *   Effect.tryPromise({
 *     try: () => fetch(`https://jsonplaceholder.typicode.com/todos/${id}`),
 *     // remap the error
 *     catch: (cause) => new TodoFetchError({ cause })
 *   })
 *
 * //      ┌─── Effect<Response, TodoFetchError, never>
 * //      ▼
 * const program = getTodo(1)
 * ```
 *
 * @see {@link promise} if the effectful computation is asynchronous and does not throw errors.
 * @category creating effects
 * @since 2.0.0
 */
export const tryPromise: <A, E = Cause.UnknownError>(
  options:
    | { readonly try: (signal: AbortSignal) => PromiseLike<A>; readonly catch: (error: unknown) => E }
    | ((signal: AbortSignal) => PromiseLike<A>)
) => Effect<A, E> = internal.tryPromise

/**
 * Creates an `Effect` that always succeeds with a given value.
 *
 * **When to use**
 *
 * Use when you use this function when you need an effect that completes successfully with a
 * specific value without any errors or external dependencies.
 *
 * **Example** (Creating a successful effect)
 *
 * ```ts
 * import { Effect } from "effect"
 *
 * // Creating an effect that represents a successful scenario
 * //
 * //      ┌─── Effect<number, never, never>
 * //      ▼
 * const success = Effect.succeed(42)
 * ```
 *
 * @see {@link fail} to create an effect that represents a failure.
 * @category creating effects
 * @since 2.0.0
 */
export const succeed: <A>(value: A) => Effect<A> = internal.succeed

/**
 * Returns an effect which succeeds with `None`.
 *
 * **Example** (Succeeding with Option.none)
 *
 * ```ts
 * import { Effect } from "effect"
 *
 * const program = Effect.succeedNone
 *
 * Effect.runPromise(program).then(console.log)
 * // Output: { _id: 'Option', _tag: 'None' }
 * ```
 *
 * @category creating effects
 * @since 2.0.0
 */
export const succeedNone: Effect<Option<never>> = internal.succeedNone

/**
 * Returns an effect which succeeds with the value wrapped in a `Some`.
 *
 * **Example** (Succeeding with Option.some)
 *
 * ```ts
 * import { Effect } from "effect"
 *
 * const program = Effect.succeedSome(42)
 *
 * Effect.runPromise(program).then(console.log)
 * // Output: { _id: 'Option', _tag: 'Some', value: 42 }
 * ```
 *
 * @category creating effects
 * @since 2.0.0
 */
export const succeedSome: <A>(value: A) => Effect<Option<A>> = internal.succeedSome

/**
 * Creates an `Effect` lazily, delaying construction until it is needed.
 *
 * **When to use**
 *
 * Use when you need to defer the evaluation of an effect until it is required. This is particularly useful for optimizing expensive computations, managing circular dependencies, or resolving type inference issues.
 *
 * **Details**
 *
 * `suspend` takes a thunk that represents the effect and wraps it in a suspended effect. This means the effect will not be created until it is explicitly needed, which is helpful in various scenarios:
 * - **Lazy Evaluation**: Helps optimize performance by deferring computations, especially when the effect might not be needed, or when its computation is expensive. This also ensures that any side effects or scoped captures are re-executed on each invocation.
 * - **Handling Circular Dependencies**: Useful in managing circular dependencies, such as recursive functions that need to avoid eager evaluation to prevent stack overflow.
 * - **Unifying Return Types**: Can help TypeScript unify return types in situations where multiple branches of logic return different effects, simplifying type inference.
 *
 * **Example** (Lazily evaluating side effects)
 *
 * ```ts
 * import { Effect } from "effect"
 *
 * let i = 0
 *
 * const bad = Effect.succeed(i++)
 *
 * const good = Effect.suspend(() => Effect.succeed(i++))
 *
 * console.log(Effect.runSync(bad)) // Output: 0
 * console.log(Effect.runSync(bad)) // Output: 0
 *
 * console.log(Effect.runSync(good)) // Output: 1
 * console.log(Effect.runSync(good)) // Output: 2
 * ```
 *
 * **Example** (Suspending recursive Fibonacci evaluation)
 *
 * ```ts
 * import { Effect } from "effect"
 *
 * const blowsUp = (n: number): Effect.Effect<number> =>
 *   n < 2
 *     ? Effect.succeed(1)
 *     : Effect.zipWith(blowsUp(n - 1), blowsUp(n - 2), (a, b) => a + b)
 *
 * // console.log(Effect.runSync(blowsUp(32)))
 * // crash: JavaScript heap out of memory
 *
 * const allGood = (n: number): Effect.Effect<number> =>
 *   n < 2
 *     ? Effect.succeed(1)
 *     : Effect.zipWith(
 *         Effect.suspend(() => allGood(n - 1)),
 *         Effect.suspend(() => allGood(n - 2)),
 *         (a, b) => a + b
 *       )
 *
 * console.log(Effect.runSync(allGood(32)))
 * // Output: 3524578
 * ```
 *
 * **Example** (Helping TypeScript infer recursive effect types)
 *
 * ```ts
 * import { Effect } from "effect"
 *
 * //   Without suspend, TypeScript may struggle with type inference.
 * //   Inferred type:
 * //     (a: number, b: number) =>
 * //       Effect<never, Error, never> | Effect<number, never, never>
 * const withoutSuspend = (a: number, b: number) =>
 *   b === 0
 *     ? Effect.fail(new Error("Cannot divide by zero"))
 *     : Effect.succeed(a / b)
 *
 * //   Using suspend to unify return types.
 * //   Inferred type:
 * //     (a: number, b: number) => Effect<number, Error, never>
 * const withSuspend = (a: number, b: number) =>
 *   Effect.suspend(() =>
 *     b === 0
 *       ? Effect.fail(new Error("Cannot divide by zero"))
 *       : Effect.succeed(a / b)
 *   )
 * ```
 *
 * @category creating effects
 * @since 2.0.0
 */
export const suspend: <A, E, R>(
  effect: LazyArg<Effect<A, E, R>>
) => Effect<A, E, R> = internal.suspend

/**
 * Creates an `Effect` that represents a synchronous side-effectful computation.
 *
 * **When to use**
 *
 * Use when you are sure the operation will not fail.
 *
 * **Details**
 *
 * The provided function is evaluated lazily when the effect runs.
 *
 * **Gotchas**
 *
 * The function must not throw. If it throws, the thrown value is treated as a
 * defect, not as a typed failure. Use `try` when throwing is expected.
 *
 * **Example** (Capturing synchronous logging in an Effect)
 *
 * ```ts
 * import { Effect } from "effect"
 *
 * const log = (message: string) =>
 *   Effect.sync(() => {
 *     console.log(message) // side effect
 *   })
 *
 * //      ┌─── Effect<void, never, never>
 * //      ▼
 * const program = log("Hello, World!")
 * ```
 *
 * @see {@link try_ | try} for a version that can handle failures.
 * @category creating effects
 * @since 2.0.0
 */
export const sync: <A>(thunk: LazyArg<A>) => Effect<A> = internal.sync

const void_: Effect<void> = internal.void
export {
  /**
   * Returns an effect that succeeds with `void`.
   *
   * @category creating effects
   * @since 2.0.0
   */
  void_ as void
}

const undefined_: Effect<undefined> = internal.undefined
export {
  /**
   * Returns an effect that succeeds with `undefined`.
   *
   * @category creating effects
   * @since 4.0.0
   */
  undefined_ as undefined
}

/**
 * Creates an `Effect` from a callback-based asynchronous API.
 *
 * **When to use**
 *
 * Use when integrating APIs that complete through callbacks
 * instead of returning a `Promise`.
 *
 * **Details**
 *
 * The registration function receives a `resume` callback and, when requested,
 * an `AbortSignal`. Call `resume` at most once with the effect that should
 * complete the fiber; later calls are ignored. Return an optional cleanup
 * effect from the registration function to run if the fiber is interrupted.
 *
 * **Example** (Integrating callback APIs)
 *
 * ```ts
 * import { Effect } from "effect"
 *
 * const delay = (ms: number) =>
 *   Effect.callback<void>((resume) => {
 *     const timeoutId = setTimeout(() => {
 *       resume(Effect.void)
 *     }, ms)
 *     // Cleanup function for interruption
 *     return Effect.sync(() => clearTimeout(timeoutId))
 *   })
 *
 * const program = delay(1000)
 * ```
 *
 * @category creating effects
 * @since 4.0.0
 */
export const callback: <A, E = never, R = never>(
  register: (
    this: Scheduler,
    resume: (effect: Effect<A, E, R>) => void,
    signal: AbortSignal
  ) => void | Effect<void, never, R>
) => Effect<A, E, R> = internal.callback

/**
 * Returns an effect that will never produce anything. The moral equivalent of
 * `while(true) {}`, only without the wasted CPU cycles.
 *
 * **Example** (Creating a never-ending effect)
 *
 * ```ts
 * import { Effect } from "effect"
 *
 * // This effect will never complete
 * const program = Effect.never
 *
 * // This will run forever (or until interrupted)
 * // Effect.runPromise(program) // Never resolves
 *
 * // Use with timeout for practical applications
 * const timedProgram = Effect.timeout(program, "1 second")
 * ```
 *
 * @category creating effects
 * @since 2.0.0
 */
export const never: Effect<never> = internal.never

/**
 * Effect that succeeds with an empty record `{}`, used as the starting point
 * for do notation chains.
 *
 * **Example** (Starting do notation)
 *
 * ```ts
 * import { Effect, pipe } from "effect"
 *
 * const program = pipe(
 *   Effect.Do,
 *   Effect.bind("x", () => Effect.succeed(2)),
 *   Effect.bind("y", ({ x }) => Effect.succeed(x + 1)),
 *   Effect.let("sum", ({ x, y }) => x + y)
 * )
 * ```
 *
 * @category do notation
 * @since 2.0.0
 */
export const Do: Effect<{}> = internal.Do

/**
 * Gives a name to the success value of an `Effect`, creating a single-key
 * record used in do notation pipelines.
 *
 * **When to use**
 *
 * Use to start a do-notation pipeline from an existing `Effect` when its
 * success value should become the first named field in the accumulated record.
 *
 * @see {@link Do} for starting from an empty accumulated record
 * @see {@link bind} for adding fields produced by effects
 *
 * @category do notation
 * @since 2.0.0
 */
export const bindTo: {
  <N extends string>(name: N): <A, E, R>(self: Effect<A, E, R>) => Effect<{ [K in N]: A }, E, R>
  <A, E, R, N extends string>(self: Effect<A, E, R>, name: N): Effect<{ [K in N]: A }, E, R>
} = internal.bindTo

const let_: {
  <N extends string, A extends Record<string, any>, B>(
    name: N,
    f: (a: NoInfer<A>) => B
  ): <E, R>(
    self: Effect<A, E, R>
  ) => Effect<Simplify<Omit<A, N> & Record<N, B>>, E, R>
  <A extends Record<string, any>, E, R, B, N extends string>(
    self: Effect<A, E, R>,
    name: N,
    f: (a: NoInfer<A>) => B
  ): Effect<Simplify<Omit<A, N> & Record<N, B>>, E, R>
} = internal.let

export {
  /**
   * Adds a computed plain value to the do notation record.
   *
   * **When to use**
   *
   * Use to add a derived, synchronous value to a do-notation pipeline when it
   * depends on fields already accumulated in the record and does not need to run
   * another `Effect`.
   *
   * **Details**
   *
   * The new field is added with object spreading. If the name already exists in
   * the record, the computed value replaces it in the returned type.
   *
   * @see {@link bind} for adding fields produced by effects
   * @see {@link bindTo} for naming an existing success value
   * @see {@link Do} for starting from an empty accumulated record
   * @see {@link gen} for sequencing without accumulating a record
   *
   * @category do notation
   * @since 2.0.0
   */
  let_ as let
}

/**
 * Adds an `Effect` value to the do notation record under a given name.
 *
 * **When to use**
 *
 * Use to sequence an effectful step in a do-notation pipeline when that step
 * depends on fields already accumulated in the record and its success value
 * should be stored under a name.
 *
 * **Details**
 *
 * The function receives the current record, runs the returned effect after the
 * input effect succeeds, and inserts its success value under `name`. The
 * resulting effect combines the error and service requirements of both steps.
 *
 * **Gotchas**
 *
 * Binding a name that already exists replaces that field in the resulting
 * record.
 *
 * @see {@link Do} for starting from an empty do-notation record
 * @see {@link bindTo} for naming the success value of an existing effect
 * @see {@link gen} for generator-based sequencing without accumulating a record
 *
 * @category do notation
 * @since 2.0.0
 */
export const bind: {
  <N extends string, A extends Record<string, any>, B, E2, R2>(
    name: N,
    f: (a: NoInfer<A>) => Effect<B, E2, R2>
  ): <E, R>(
    self: Effect<A, E, R>
  ) => Effect<Simplify<Omit<A, N> & Record<N, B>>, E | E2, R | R2>
  <A extends Record<string, any>, E, R, B, E2, R2, N extends string>(
    self: Effect<A, E, R>,
    name: N,
    f: (a: NoInfer<A>) => Effect<B, E2, R2>
  ): Effect<Simplify<Omit<A, N> & Record<N, B>>, E | E2, R | R2>
} = internal.bind

/**
 * Provides a way to write effectful code using generator functions, simplifying
 * control flow and error handling.
 *
 * **When to use**
 *
 * Use when `gen` allows you to write code that looks and behaves like synchronous
 * code, but it can handle asynchronous tasks, errors, and complex control flow
 * (like loops and conditions). It helps make asynchronous code more readable
 * and easier to manage.
 *
 * The generator functions work similarly to `async/await` but with more
 * explicit control over the execution of effects. You can `yield*` values from
 * effects and return the final result at the end.
 *
 * **Example** (Sequencing effects with generators)
 *
 * ```ts
 * import { Data, Effect } from "effect"
 *
 * class DiscountRateError extends Data.TaggedError("DiscountRateError")<{}> {}
 *
 * const addServiceCharge = (amount: number) => amount + 1
 *
 * const applyDiscount = (
 *   total: number,
 *   discountRate: number
 * ): Effect.Effect<number, DiscountRateError> =>
 *   discountRate === 0
 *     ? Effect.fail(new DiscountRateError())
 *     : Effect.succeed(total - (total * discountRate) / 100)
 *
 * const fetchTransactionAmount = Effect.promise(() => Promise.resolve(100))
 *
 * const fetchDiscountRate = Effect.promise(() => Promise.resolve(5))
 *
 * export const program = Effect.gen(function*() {
 *   const transactionAmount = yield* fetchTransactionAmount
 *   const discountRate = yield* fetchDiscountRate
 *   const discountedAmount = yield* applyDiscount(
 *     transactionAmount,
 *     discountRate
 *   )
 *   const finalAmount = addServiceCharge(discountedAmount)
 *   return `Final amount to charge: ${finalAmount}`
 * })
 * ```
 *
 * @category creating effects
 * @since 2.0.0
 */
export const gen: {
  <Eff extends Effect<any, any, any>, AEff>(
    f: () => Generator<Eff, AEff, never>
  ): Effect<
    AEff,
    [Eff] extends [never] ? never
      : [Eff] extends [Effect<infer _A, infer E, infer _R>] ? E
      : never,
    [Eff] extends [never] ? never
      : [Eff] extends [Effect<infer _A, infer _E, infer R>] ? R
      : never
  >
  <Self, Eff extends Effect<any, any, any>, AEff>(
    options: {
      readonly self: Self
    },
    f: (this: Self) => Generator<Eff, AEff, never>
  ): Effect<
    AEff,
    [Eff] extends [never] ? never
      : [Eff] extends [Effect<infer _A, infer E, infer _R>] ? E
      : never,
    [Eff] extends [never] ? never
      : [Eff] extends [Effect<infer _A, infer _E, infer R>] ? R
      : never
  >
} = internal.gen

/**
 * Type helpers for `Effect.gen` generator return signatures.
 *
 * @since 2.0.0
 */
export declare namespace gen {
  /**
   * Generator return type accepted by `Effect.gen`.
   *
   * @category creating effects
   * @since 4.0.0
   */
  export type Return<A, E = never, R = never> = Generator<Effect<any, E, R>, A, any>
}

/**
 * Creates an `Effect` that represents a recoverable error.
 *
 * **When to use**
 *
 * Use to explicitly signal an error in an `Effect`. The error
 * will keep propagating unless it is handled. You can handle the error with
 * functions like {@link catchTag} or {@link catchTags}.
 *
 * **Example** (Creating a failed effect)
 *
 * ```ts
 * import { Data, Effect } from "effect"
 *
 * class OperationFailedError extends Data.TaggedError("OperationFailedError")<{}> {}
 *
 * //      ┌─── Effect<never, OperationFailedError, never>
 * //      ▼
 * const failure = Effect.fail(
 *   new OperationFailedError()
 * )
 * ```
 *
 * @see {@link succeed} to create an effect that represents a successful value.
 * @category creating effects
 * @since 2.0.0
 */
export const fail: <E>(error: E) => Effect<never, E> = internal.fail

/**
 * Creates an `Effect` that represents a recoverable error using a lazy evaluation.
 *
 * **When to use**
 *
 * Use to defer computing a recoverable error value until the effect is run.
 *
 * **Details**
 *
 * The error-producing function is evaluated each time the effect is executed.
 *
 * **Example** (Lazily creating failures)
 *
 * ```ts
 * import { Data, Effect } from "effect"
 *
 * class ProgramError extends Data.TaggedError("ProgramError")<{ readonly failedAt: Date }> {}
 *
 * const program = Effect.failSync(() => new ProgramError({ failedAt: new Date() }))
 *
 * Effect.runPromiseExit(program).then(console.log)
 * // Output: { _id: 'Exit', _tag: 'Failure', cause: ... }
 * ```
 *
 * @category creating effects
 * @since 2.0.0
 */
export const failSync: <E>(evaluate: LazyArg<E>) => Effect<never, E> = internal.failSync

/**
 * Creates an `Effect` that represents a failure with a specific `Cause`.
 *
 * **Details**
 *
 * This function allows you to create effects that fail with complex error
 * structures, including multiple errors, defects, interruptions, and more.
 *
 * **Example** (Failing with a full Cause)
 *
 * ```ts
 * import { Cause, Effect } from "effect"
 *
 * const program = Effect.failCause(
 *   Cause.fail("Network error")
 * )
 *
 * Effect.runPromiseExit(program).then(console.log)
 * // Output: { _id: 'Exit', _tag: 'Failure', cause: ... }
 * ```
 *
 * @category creating effects
 * @since 2.0.0
 */
export const failCause: <E>(cause: Cause.Cause<E>) => Effect<never, E> = internal.failCause

/**
 * Creates an `Effect` that represents a failure with a `Cause` computed lazily.
 *
 * **When to use**
 *
 * Use to defer computing a full `Cause` until the effect is run.
 *
 * **Details**
 *
 * The cause-producing function is evaluated each time the effect is executed.
 *
 * **Example** (Lazily creating a Cause)
 *
 * ```ts
 * import { Cause, Effect } from "effect"
 *
 * const program = Effect.failCauseSync(() =>
 *   Cause.fail("Error computed at runtime")
 * )
 *
 * Effect.runPromiseExit(program).then(console.log)
 * // Output: { _id: 'Exit', _tag: 'Failure', cause: ... }
 * ```
 *
 * @category creating effects
 * @since 2.0.0
 */
export const failCauseSync: <E>(
  evaluate: LazyArg<Cause.Cause<E>>
) => Effect<never, E> = internal.failCauseSync

/**
 * Creates an effect that terminates a fiber with a specified error.
 *
 * **When to use**
 *
 * Use when encountering unexpected conditions in your code that should
 * not be handled as regular errors but instead represent unrecoverable defects.
 *
 * **Details**
 *
 * The `die` function is used to signal a defect, which represents a critical
 * and unexpected error in the code. When invoked, it produces an effect that
 * does not handle the error and instead terminates the fiber.
 *
 * The error channel of the resulting effect is of type `never`, indicating that
 * it cannot recover from this failure.
 *
 * **Example** (Failing when division by zero)
 *
 * ```ts
 * import { Effect } from "effect"
 *
 * const divide = (a: number, b: number) =>
 *   b === 0
 *     ? Effect.die(new Error("Cannot divide by zero"))
 *     : Effect.succeed(a / b)
 *
 * //      ┌─── Effect<number, never, never>
 * //      ▼
 * const program = divide(1, 0)
 *
 * Effect.runPromise(program).catch(console.error)
 * // Output:
 * // (FiberFailure) Error: Cannot divide by zero
 * //   ...stack trace...
 * ```
 *
 * @category creating effects
 * @since 2.0.0
 */
export const die: (defect: unknown) => Effect<never> = internal.die

const try_: <A, E>(options: {
  try: LazyArg<A>
  catch: (error: unknown) => E
}) => Effect<A, E> = internal.try

export {
  /**
   * Creates an `Effect` that represents a synchronous computation that might
   * fail.
   *
   * **When to use**
   *
   * Use when in situations where you need to perform synchronous operations that might
   * fail, such as parsing JSON, you can use the `try` constructor. This
   * constructor is designed to handle operations that could throw exceptions by
   * capturing those exceptions and transforming them into manageable errors.
   *
   * **Details**
   *
   * Error Handling:
   *
   * There are two ways to handle errors with `try`:
   *
   * 1. If you don't provide a `catch` function, the error is caught and the
   *    effect fails with an `UnknownError`.
   * 2. If you provide a `catch` function, the error is caught and the `catch`
   *    function maps it to an error of type `E`.
   *
   * **Example** (Parsing JSON with typed error mapping)
   *
   * ```ts
   * import { Effect } from "effect"
   *
   * const parseJSON = (input: string) =>
   *   Effect.try({
   *     try: () => JSON.parse(input),
   *     catch: (error) => error as Error
   *   })
   *
   * // Success case
   * Effect.runPromise(parseJSON("{\"name\": \"Alice\"}")).then(console.log)
   * // Output: { name: "Alice" }
   *
   * // Failure case
   * Effect.runPromiseExit(parseJSON("invalid json")).then(console.log)
   * // Output: Exit.failure with Error
   * ```
   *
   * **Example** (Mapping synchronous exceptions to a tagged error)
   *
   * ```ts
   * import { Data, Effect } from "effect"
   *
   * class JsonParsingError extends Data.TaggedError("JsonParsingError")<{ readonly cause: unknown }> {}
   *
   * const parseJSON = (input: string) =>
   *   Effect.try({
   *     try: () => JSON.parse(input),
   *     catch: (cause) => new JsonParsingError({ cause })
   *   })
   *
   * Effect.runPromiseExit(parseJSON("invalid json")).then(console.log)
   * // Output: Exit.failure with custom Error message
   * ```
   *
   * @see {@link sync} if the effectful computation is synchronous and does not
   * throw errors.
   * @category creating effects
   * @since 2.0.0
   */
  try_ as try
}

/**
 * Yields control back to the Effect runtime, allowing other fibers to execute.
 *
 * **Example** (Yielding to other fibers)
 *
 * ```ts
 * import { Effect } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   console.log("Before yield")
 *   yield* Effect.yieldNow
 *   console.log("After yield")
 * })
 *
 * Effect.runPromise(program)
 * ```
 *
 * @category creating effects
 * @since 2.0.0
 */
export const yieldNow: Effect<void> = internal.yieldNow

/**
 * Yields control back to the Effect runtime with a specified priority, allowing other fibers to execute.
 *
 * **Example** (Yielding with priority)
 *
 * ```ts
 * import { Effect } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   console.log("High priority task")
 *   yield* Effect.yieldNowWith(10) // Higher priority
 *   console.log("Continued after yield")
 * })
 *
 * Effect.runPromise(program)
 * ```
 *
 * @category creating effects
 * @since 4.0.0
 */
export const yieldNowWith: (priority?: number) => Effect<void> = internal.yieldNowWith

/**
 * Provides access to the current fiber within an effect computation.
 *
 * **Example** (Reading the current fiber)
 *
 * ```ts
 * import { Effect } from "effect"
 *
 * const program = Effect.withFiber((fiber) =>
 *   Effect.succeed(`Fiber ID: ${fiber.id}`)
 * )
 *
 * Effect.runPromise(program).then(console.log)
 * // Output: Fiber ID: 1
 * ```
 *
 * @category creating effects
 * @since 4.0.0
 */
export const withFiber: <A, E = never, R = never>(
  evaluate: (fiber: Fiber<unknown, unknown>) => Effect<A, E, R>
) => Effect<A, E, R> = core.withFiber

// -----------------------------------------------------------------------------
// Conversions
// -----------------------------------------------------------------------------

/**
 * Converts a `Result` to an `Effect`.
 *
 * **Example** (Converting a Result into an Effect)
 *
 * ```ts
 * import { Effect, Result } from "effect"
 *
 * const success = Result.succeed(42)
 * const failure = Result.fail("Something went wrong")
 *
 * const effect1 = Effect.fromResult(success)
 * const effect2 = Effect.fromResult(failure)
 *
 * Effect.runPromise(effect1).then(console.log) // 42
 * Effect.runPromiseExit(effect2).then(console.log)
 * // { _id: 'Exit', _tag: 'Failure', cause: { _id: 'Cause', _tag: 'Fail', failure: 'Something went wrong' } }
 * ```
 *
 * @category converting
 * @since 4.0.0
 */
export const fromResult: <A, E>(result: Result.Result<A, E>) => Effect<A, E> = internal.fromResult

/**
 * Converts an `Option` into an `Effect`.
 *
 * **Details**
 *
 * `Option.some` becomes a successful effect with the contained value, while
 * `Option.none` becomes a failed effect with `NoSuchElementError`.
 *
 * **Example** (Converting an Option into an Effect)
 *
 * ```ts
 * import { Effect, Option } from "effect"
 *
 * const some = Option.some(42)
 * const none = Option.none()
 *
 * const effect1 = Effect.fromOption(some)
 * const effect2 = Effect.fromOption(none)
 *
 * Effect.runPromise(effect1).then(console.log) // 42
 * Effect.runPromiseExit(effect2).then(console.log)
 * // { _id: 'Exit', _tag: 'Failure', cause: { _id: 'Cause', _tag: 'Fail', failure: { _id: 'NoSuchElementError' } } }
 * ```
 *
 * @category converting
 * @since 4.0.0
 */
export const fromOption: <A>(
  option: Option<A>
) => Effect<A, Cause.NoSuchElementError> = internal.fromOption

/**
 * Converts a nullable value to an `Effect`, failing with a `NoSuchElementError`
 * when the value is `null` or `undefined`.
 *
 * **Example** (Failing on nullish values)
 *
 * ```ts
 * import { Console, Effect } from "effect"
 *
 * const program = Effect.fn(function*(input: string | null) {
 *   const value = yield* Effect.fromNullishOr(input)
 *   yield* Console.log(value)
 * },
 *   Effect.catch(() => Console.log("missing"))
 * )
 *
 * Effect.runPromise(program(null))
 * // Output: missing
 * Effect.runPromise(program("hello"))
 * // Output: hello
 * ```
 *
 * @category converting
 * @since 4.0.0
 */
export const fromNullishOr: <A>(value: A) => Effect<NonNullable<A>, Cause.NoSuchElementError> = internal.fromNullishOr

// -----------------------------------------------------------------------------
// Mapping
// -----------------------------------------------------------------------------

/**
 * Chains effects to produce new `Effect` instances, useful for combining
 * operations that depend on previous results.
 *
 * **When to use**
 *
 * Use when you need to chain multiple effects, ensuring that each
 * step produces a new `Effect` while flattening any nested effects that may
 * occur.
 *
 * **Details**
 *
 * `flatMap` lets you sequence effects so that the result of one effect can be
 * used in the next step. It is similar to `flatMap` used with arrays but works
 * specifically with `Effect` instances, allowing you to avoid deeply nested
 * effect structures.
 *
 * Since effects are immutable, `flatMap` always returns a new effect instead of
 * changing the original one.
 *
 * **Example** (Syntax)
 *
 * ```ts
 * import { Effect, pipe } from "effect"
 *
 * const myEffect = Effect.succeed(1)
 * const transformation = (n: number) => Effect.succeed(n + 1)
 *
 * const flatMappedWithPipe = pipe(myEffect, Effect.flatMap(transformation))
 * const flatMappedWithDataFirst = Effect.flatMap(myEffect, transformation)
 * const flatMappedWithMethod = myEffect.pipe(Effect.flatMap(transformation))
 * ```
 *
 * **Example** (Sequencing dependent effects)
 *
 * ```ts
 * import { Data, Effect, pipe } from "effect"
 *
 * class DiscountRateError extends Data.TaggedError("DiscountRateError")<{}> {}
 *
 * // Function to apply a discount safely to a transaction amount
 * const applyDiscount = (
 *   total: number,
 *   discountRate: number
 * ): Effect.Effect<number, DiscountRateError> =>
 *   discountRate === 0
 *     ? Effect.fail(new DiscountRateError())
 *     : Effect.succeed(total - (total * discountRate) / 100)
 *
 * // Simulated asynchronous task to fetch a transaction amount from database
 * const fetchTransactionAmount = Effect.promise(() => Promise.resolve(100))
 *
 * // Chaining the fetch and discount application using `flatMap`
 * const finalAmount = pipe(
 *   fetchTransactionAmount,
 *   Effect.flatMap((amount) => applyDiscount(amount, 5))
 * )
 *
 * Effect.runPromise(finalAmount).then(console.log)
 * // Output: 95
 * ```
 *
 * @see {@link tap} for a version that ignores the result of the effect.
 * @category sequencing
 * @since 2.0.0
 */
export const flatMap: {
  <A, B, E1, R1>(
    f: (a: A) => Effect<B, E1, R1>
  ): <E, R>(self: Effect<A, E, R>) => Effect<B, E1 | E, R1 | R>
  <A, E, R, B, E1, R1>(
    self: Effect<A, E, R>,
    f: (a: A) => Effect<B, E1, R1>
  ): Effect<B, E | E1, R | R1>
} = internal.flatMap

/**
 * Flattens an `Effect` that produces another `Effect` into a single effect.
 *
 * **Example** (Flattening nested effects)
 *
 * ```ts
 * import { Console, Effect } from "effect"
 *
 * const nested = Effect.succeed(Effect.succeed("hello"))
 *
 * const program = Effect.gen(function*() {
 *   const value = yield* Effect.flatten(nested)
 *   yield* Console.log(value)
 *   // Output: hello
 * })
 * ```
 *
 * @category sequencing
 * @since 2.0.0
 */
export const flatten: <A, E, R, E2, R2>(self: Effect<Effect<A, E, R>, E2, R2>) => Effect<A, E | E2, R | R2> =
  internal.flatten

/**
 * Runs this effect and then runs another effect, optionally using the first
 * effect's success value to choose the next effect.
 *
 * **When to use**
 *
 * Use when one effect must run after another and the second effect
 * may depend on the first effect's success value.
 *
 * **Details**
 *
 * When the second argument is an `Effect`, the first success value is discarded
 * and the returned effect produces the second effect's value. When the second
 * argument is a function, it receives the first success value and must return
 * the next `Effect`.
 *
 * Failures or requirements from either effect are preserved in the returned
 * effect.
 *
 * **Example** (Syntax)
 *
 * ```ts
 * import { Effect, pipe } from "effect"
 *
 * const myEffect = Effect.succeed(1)
 * const anotherEffect = Effect.succeed("done")
 *
 * const transformedWithPipe = pipe(myEffect, Effect.andThen(anotherEffect))
 * const transformedWithDataFirst = Effect.andThen(myEffect, anotherEffect)
 * const transformedWithMethod = myEffect.pipe(Effect.andThen(anotherEffect))
 * ```
 *
 * **Example** (Sequencing a discount calculation after fetching a total)
 *
 * ```ts
 * import { Data, Effect, pipe } from "effect"
 *
 * class DiscountRateError extends Data.TaggedError("DiscountRateError")<{}> {}
 *
 * // Function to apply a discount safely to a transaction amount
 * const applyDiscount = (
 *   total: number,
 *   discountRate: number
 * ): Effect.Effect<number, DiscountRateError> =>
 *   discountRate === 0
 *     ? Effect.fail(new DiscountRateError())
 *     : Effect.succeed(total - (total * discountRate) / 100)
 *
 * // Simulated asynchronous task to fetch a transaction amount from database
 * const fetchTransactionAmount = Effect.promise(() => Promise.resolve(100))
 *
 * // Using Effect.map and Effect.flatMap
 * const result1 = pipe(
 *   fetchTransactionAmount,
 *   Effect.map((amount) => amount * 2),
 *   Effect.flatMap((amount) => applyDiscount(amount, 5))
 * )
 *
 * Effect.runPromise(result1).then(console.log)
 * // Output: 190
 *
 * // Using Effect.andThen
 * const result2 = pipe(
 *   fetchTransactionAmount,
 *   Effect.andThen((amount) => Effect.succeed(amount * 2)),
 *   Effect.andThen((amount) => applyDiscount(amount, 5))
 * )
 *
 * Effect.runPromise(result2).then(console.log)
 * // Output: 190
 * ```
 *
 * @category sequencing
 * @since 2.0.0
 */
export const andThen: {
  <A, B, E2, R2>(
    f: (a: A) => Effect<B, E2, R2>
  ): <E, R>(self: Effect<A, E, R>) => Effect<B, E | E2, R | R2>
  <B, E2, R2>(
    f: Effect<B, E2, R2>
  ): <A, E, R>(self: Effect<A, E, R>) => Effect<B, E | E2, R | R2>
  <A, E, R, B, E2, R2>(
    self: Effect<A, E, R>,
    f: (a: A) => Effect<B, E2, R2>
  ): Effect<B, E | E2, R | R2>
  <A, E, R, B, E2, R2>(
    self: Effect<A, E, R>,
    f: Effect<B, E2, R2>
  ): Effect<B, E | E2, R | R2>
} = internal.andThen

/**
 * Runs a side effect with the result of an effect without changing the original
 * value.
 *
 * **When to use**
 *
 * Use when you want to perform a side effect, like logging or tracking,
 * without modifying the main value. This is useful when you need to observe or
 * record an action but want the original value to be passed to the next step.
 *
 * **Details**
 *
 * `tap` works similarly to `flatMap`, but it ignores the result of the function
 * passed to it. The value from the previous effect remains available for the
 * next part of the chain. Note that if the side effect fails, the entire chain
 * will fail too.
 *
 * **Example** (Logging a step in a pipeline)
 *
 * ```ts
 * import { Console, Data, Effect, pipe } from "effect"
 *
 * class DiscountRateError extends Data.TaggedError("DiscountRateError")<{}> {}
 *
 * // Function to apply a discount safely to a transaction amount
 * const applyDiscount = (
 *   total: number,
 *   discountRate: number
 * ): Effect.Effect<number, DiscountRateError> =>
 *   discountRate === 0
 *     ? Effect.fail(new DiscountRateError())
 *     : Effect.succeed(total - (total * discountRate) / 100)
 *
 * // Simulated asynchronous task to fetch a transaction amount from database
 * const fetchTransactionAmount = Effect.promise(() => Promise.resolve(100))
 *
 * const finalAmount = pipe(
 *   fetchTransactionAmount,
 *   // Log the fetched transaction amount
 *   Effect.tap((amount) => Console.log(`Apply a discount to: ${amount}`)),
 *   // `amount` is still available!
 *   Effect.flatMap((amount) => applyDiscount(amount, 5))
 * )
 *
 * Effect.runPromise(finalAmount).then(console.log)
 * // Output:
 * // Apply a discount to: 100
 * // 95
 * ```
 *
 * @category sequencing
 * @since 2.0.0
 */
export const tap: {
  <A, B, E2, R2>(
    f: (a: NoInfer<A>) => Effect<B, E2, R2>
  ): <E, R>(self: Effect<A, E, R>) => Effect<A, E | E2, R | R2>
  <B, E2, R2>(
    f: Effect<B, E2, R2>
  ): <A, E, R>(self: Effect<A, E, R>) => Effect<A, E | E2, R | R2>
  <A, E, R, B, E2, R2>(
    self: Effect<A, E, R>,
    f: (a: NoInfer<A>) => Effect<B, E2, R2>
  ): Effect<A, E | E2, R | R2>
  <A, E, R, B, E2, R2>(
    self: Effect<A, E, R>,
    f: Effect<B, E2, R2>
  ): Effect<A, E | E2, R | R2>
} = internal.tap

/**
 * Converts both success and failure of an `Effect` into a `Result` type.
 *
 * **When to use**
 *
 * Use when you want to handle typed failures as data while preserving
 * the original error value. Use `option` when you only care whether the effect
 * succeeded, and `exit` when you need the full failure cause.
 *
 * **Details**
 *
 * This function converts an effect that may fail into an effect that always
 * succeeds, wrapping the outcome in a `Result` type. The result will be
 * `Result.Err` if the effect fails, containing the recoverable error, or
 * `Result.Ok` if it succeeds, containing the result.
 *
 * Using this function, you can handle recoverable errors explicitly without
 * causing the effect to fail. This is particularly useful in scenarios where
 * you want to chain effects and manage both success and failure in the same
 * logical flow.
 *
 * The resulting effect cannot fail directly because all recoverable failures
 * are represented inside the `Result` type.
 *
 * **Gotchas**
 *
 * `result` only captures typed, recoverable failures. Defects and
 * interruptions are not captured inside the `Result` and still fail the
 * effect.
 *
 * **Example** (Capturing success or failure as Result)
 *
 * ```ts
 * import { Effect } from "effect"
 *
 * const success = Effect.succeed(42)
 * const failure = Effect.fail("Something went wrong")
 *
 * const program1 = Effect.result(success)
 * const program2 = Effect.result(failure)
 *
 * Effect.runPromise(program1).then(console.log)
 * // { _id: 'Result', _tag: 'Success', value: 42 }
 *
 * Effect.runPromise(program2).then(console.log)
 * // { _id: 'Result', _tag: 'Failure', error: 'Something went wrong' }
 * ```
 *
 * @see {@link option} for a version that uses `Option` instead.
 * @see {@link exit} for a version that encapsulates both recoverable errors and defects in an `Exit`.
 *
 * @category outcome encapsulation
 * @since 4.0.0
 */
export const result: <A, E, R>(self: Effect<A, E, R>) => Effect<Result.Result<A, E>, never, R> = internal.result

/**
 * Converts success to `Option.some` and failure to `Option.none`.
 *
 * **When to use**
 *
 * Use when the failure value is not important and absence is enough.
 * Use `result` when you need the original typed failure, and `exit` when you
 * need the full failure cause.
 *
 * **Details**
 *
 * Success values become `Option.some`, recoverable failures become
 * `Option.none`, and defects still fail the effect.
 *
 * **Gotchas**
 *
 * `option` only captures typed, recoverable failures as `Option.none`.
 * Defects and interruptions are not captured inside the `Option` and still
 * fail the effect.
 *
 * `option` also discards typed failure values. Use `result` if the failure
 * value matters.
 *
 * **Example** (Capturing success or failure as Option)
 *
 * ```ts
 * import { Console, Effect, Option } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const someValue = yield* Effect.option(Effect.succeed(1))
 *   const noneValue = yield* Effect.option(Effect.fail("missing"))
 *
 *   yield* Console.log(Option.isSome(someValue))
 *   yield* Console.log(Option.isNone(noneValue))
 * })
 *
 * Effect.runPromise(program)
 * // true
 * // true
 * ```
 *
 * @see {@link result} for a version that uses `Result` instead.
 * @see {@link exit} for a version that encapsulates both recoverable errors and defects in an `Exit`.
 *
 * @category outcome encapsulation
 * @since 2.0.0
 */
export const option: <A, E, R>(self: Effect<A, E, R>) => Effect<Option<A>, never, R> = internal.option

/**
 * Transforms an effect to encapsulate both failure and success using the `Exit`
 * data type.
 *
 * **When to use**
 *
 * Use when you need to inspect the full outcome, including typed
 * failures, defects, and interruptions. Use `result` or `option` when you only
 * need to handle typed failures.
 *
 * **Details**
 *
 * `exit` wraps an effect's success or failure inside an `Exit` type, allowing
 * you to handle both cases explicitly.
 *
 * The resulting effect cannot fail because the failure is encapsulated within
 * the `Exit.Failure` type. The error type is set to `never`, indicating that
 * the effect is structured to never fail directly.
 *
 * **Example** (Capturing completion as Exit)
 *
 * ```ts
 * import { Effect } from "effect"
 *
 * const success = Effect.succeed(42)
 * const failure = Effect.fail("Something went wrong")
 *
 * const program1 = Effect.exit(success)
 * const program2 = Effect.exit(failure)
 *
 * Effect.runPromise(program1).then(console.log)
 * // { _id: 'Exit', _tag: 'Success', value: 42 }
 *
 * Effect.runPromise(program2).then(console.log)
 * // { _id: 'Exit', _tag: 'Failure', cause: { _id: 'Cause', _tag: 'Fail', failure: 'Something went wrong' } }
 * ```
 *
 * @see {@link option} for a version that uses `Option` instead.
 * @see {@link result} for a version that uses `Result` instead.
 *
 * @category outcome encapsulation
 * @since 2.0.0
 */
export const exit: <A, E, R>(
  self: Effect<A, E, R>
) => Effect<Exit.Exit<A, E>, never, R> = internal.exit

/**
 * Transforms the value inside an effect by applying a function to it.
 *
 * **When to use**
 *
 * Use to transform an effect's success value with a function that returns a
 * plain value, producing a new effect without changing the original effect's
 * typed error or context requirements.
 *
 * **Details**
 *
 * `map` takes a function and applies it to the value contained within an
 * effect, creating a new effect with the transformed value.
 *
 * It's important to note that effects are immutable, meaning that the original
 * effect is not modified. Instead, a new effect is returned with the updated
 * value.
 *
 * **Example** (Syntax)
 *
 * ```ts
 * import { Effect, pipe } from "effect"
 *
 * const myEffect = Effect.succeed(1)
 * const transformation = (n: number) => n + 1
 *
 * const mappedWithPipe = pipe(myEffect, Effect.map(transformation))
 * const mappedWithDataFirst = Effect.map(myEffect, transformation)
 * const mappedWithMethod = myEffect.pipe(Effect.map(transformation))
 * ```
 *
 * **Example** (Adding a service charge)
 *
 * ```ts
 * import { Effect, pipe } from "effect"
 *
 * const addServiceCharge = (amount: number) => amount + 1
 *
 * const fetchTransactionAmount = Effect.promise(() => Promise.resolve(100))
 *
 * const finalAmount = pipe(
 *   fetchTransactionAmount,
 *   Effect.map(addServiceCharge)
 * )
 *
 * Effect.runPromise(finalAmount).then(console.log)
 * // Output: 101
 * ```
 *
 * @see {@link mapError} for a version that operates on the error channel.
 * @see {@link mapBoth} for a version that operates on both channels.
 * @see {@link flatMap} or {@link andThen} for a version that can return a new effect.
 * @category mapping
 * @since 2.0.0
 */
export const map: {
  <A, B>(f: (a: A) => B): <E, R>(self: Effect<A, E, R>) => Effect<B, E, R>
  <A, E, R, B>(self: Effect<A, E, R>, f: (a: A) => B): Effect<B, E, R>
} = internal.map

/**
 * Replaces the value inside an effect with a constant value.
 *
 * **When to use**
 *
 * Use to replace a successful value with a constant while preserving failures
 * and requirements.
 *
 * **Details**
 *
 * `as` allows you to ignore the original value inside an effect and
 * replace it with a new constant value.
 *
 * **Example** (Replacing a success value)
 *
 * ```ts
 * import { Effect, pipe } from "effect"
 *
 * // Replaces the value 5 with the constant "new value"
 * const program = pipe(Effect.succeed(5), Effect.as("new value"))
 *
 * Effect.runPromise(program).then(console.log)
 * // Output: "new value"
 * ```
 *
 * @see {@link map} for deriving the replacement value from the success value
 * @see {@link asVoid} for replacing the success value with `void`
 *
 * @category mapping
 * @since 2.0.0
 */
export const as: {
  <B>(value: B): <A, E, R>(self: Effect<A, E, R>) => Effect<B, E, R>
  <A, E, R, B>(self: Effect<A, E, R>, value: B): Effect<B, E, R>
} = internal.as

/**
 * Maps the success value of an `Effect` to `Some`, preserving failures.
 *
 * **Example** (Wrapping success in Option.some)
 *
 * ```ts
 * import { Effect } from "effect"
 *
 * const program = Effect.asSome(Effect.succeed(42))
 *
 * Effect.runPromise(program).then(console.log)
 * // { _id: 'Option', _tag: 'Some', value: 42 }
 * ```
 *
 * @category mapping
 * @since 2.0.0
 */
export const asSome: <A, E, R>(self: Effect<A, E, R>) => Effect<Option<A>, E, R> = internal.asSome

/**
 * Maps the success value of an `Effect` to `void`, preserving failures.
 *
 * **Example** (Discarding success values)
 *
 * ```ts
 * import { Effect } from "effect"
 *
 * const program = Effect.asVoid(Effect.succeed(42))
 *
 * Effect.runPromise(program).then(console.log)
 * // undefined (void)
 * ```
 *
 * @category mapping
 * @since 2.0.0
 */
export const asVoid: <A, E, R>(self: Effect<A, E, R>) => Effect<void, E, R> = internal.asVoid

/**
 * Swaps an effect's success and failure channels.
 *
 * **When to use**
 *
 * Use to handle the failure value as a success, or to move the success value
 * into the failure channel.
 *
 * **Details**
 *
 * For an `Effect<A, E, R>`, the returned effect has type `Effect<E, A, R>`.
 *
 * **Example** (Swapping success and failure channels)
 *
 * ```ts
 * import { Effect } from "effect"
 *
 * //      ┌─── Effect<number, string, never>
 * //      ▼
 * const program = Effect.fail("Oh uh!").pipe(Effect.as(2))
 *
 * //      ┌─── Effect<string, number, never>
 * //      ▼
 * const flipped = Effect.flip(program)
 * ```
 *
 * @category mapping
 * @since 2.0.0
 */
export const flip: <A, E, R>(self: Effect<A, E, R>) => Effect<E, A, R> = internal.flip

// -----------------------------------------------------------------------------
// Zipping
// -----------------------------------------------------------------------------

/**
 * Combines two effects into a single effect, producing a tuple with the results of both effects.
 *
 * **When to use**
 *
 * Use to combine exactly two effects into a tuple.
 *
 * **Details**
 *
 * The `zip` function executes the first effect (left) and then the second effect (right).
 * Once both effects succeed, their results are combined into a tuple.
 *
 * Concurrency:
 *
 * By default, `zip` processes the effects sequentially. To execute the effects concurrently,
 * use the `{ concurrent: true }` option.
 *
 * **Example** (Combining two effects sequentially)
 *
 * ```ts
 * import { Effect } from "effect"
 *
 * const task1 = Effect.succeed(1).pipe(
 *   Effect.delay("200 millis"),
 *   Effect.tap(Effect.log("task1 done"))
 * )
 * const task2 = Effect.succeed("hello").pipe(
 *   Effect.delay("100 millis"),
 *   Effect.tap(Effect.log("task2 done"))
 * )
 *
 * // Combine the two effects together
 * //
 * //      ┌─── Effect<[number, string], never, never>
 * //      ▼
 * const program = Effect.zip(task1, task2)
 *
 * Effect.runPromise(program).then(console.log)
 * // Output:
 * // timestamp=... level=INFO fiber=#0 message="task1 done"
 * // timestamp=... level=INFO fiber=#0 message="task2 done"
 * // [ 1, 'hello' ]
 * ```
 *
 * **Example** (Combining two effects concurrently)
 *
 * ```ts
 * import { Effect } from "effect"
 *
 * const task1 = Effect.succeed(1).pipe(
 *   Effect.delay("200 millis"),
 *   Effect.tap(Effect.log("task1 done"))
 * )
 * const task2 = Effect.succeed("hello").pipe(
 *   Effect.delay("100 millis"),
 *   Effect.tap(Effect.log("task2 done"))
 * )
 *
 * // Run both effects concurrently using the concurrent option
 * const program = Effect.zip(task1, task2, { concurrent: true })
 *
 * Effect.runPromise(program).then(console.log)
 * // Output:
 * // timestamp=... level=INFO fiber=#0 message="task2 done"
 * // timestamp=... level=INFO fiber=#0 message="task1 done"
 * // [ 1, 'hello' ]
 * ```
 *
 * @see {@link zipWith} for a version that combines the results with a custom function.
 * @see {@link all} for collecting a larger structure of effects.
 *
 * @category zipping
 * @since 2.0.0
 */
export const zip: {
  <A2, E2, R2>(
    that: Effect<A2, E2, R2>,
    options?: { readonly concurrent?: boolean | undefined } | undefined
  ): <A, E, R>(self: Effect<A, E, R>) => Effect<[A, A2], E2 | E, R2 | R>
  <A, E, R, A2, E2, R2>(
    self: Effect<A, E, R>,
    that: Effect<A2, E2, R2>,
    options?: { readonly concurrent?: boolean | undefined }
  ): Effect<[A, A2], E | E2, R | R2>
} = internal.zip

/**
 * Combines two effects sequentially and applies a function to their results to
 * produce a single value.
 *
 * **When to use**
 *
 * Use when you need to run two effects sequentially and combine their results
 * with a function instead of keeping the results as a tuple.
 *
 * **Details**
 *
 * Concurrency:
 *
 * By default, the effects are run sequentially. To execute them concurrently,
 * use the `{ concurrent: true }` option.
 *
 * **Example** (Combining two success values with a function)
 *
 * ```ts
 * import { Effect } from "effect"
 *
 * const task1 = Effect.succeed(1).pipe(
 *   Effect.delay("200 millis"),
 *   Effect.tap(Effect.log("task1 done"))
 * )
 * const task2 = Effect.succeed("hello").pipe(
 *   Effect.delay("100 millis"),
 *   Effect.tap(Effect.log("task2 done"))
 * )
 *
 * const task3 = Effect.zipWith(
 *   task1,
 *   task2,
 *   // Combines results into a single value
 *   (number, string) => number + string.length
 * )
 *
 * Effect.runPromise(task3).then(console.log)
 * // Output:
 * // timestamp=... level=INFO fiber=#3 message="task1 done"
 * // timestamp=... level=INFO fiber=#2 message="task2 done"
 * // 6
 * ```
 *
 * @category zipping
 * @since 2.0.0
 */
export const zipWith: {
  <A2, E2, R2, A, B>(
    that: Effect<A2, E2, R2>,
    f: (a: A, b: A2) => B,
    options?: { readonly concurrent?: boolean | undefined }
  ): <E, R>(self: Effect<A, E, R>) => Effect<B, E2 | E, R2 | R>
  <A, E, R, A2, E2, R2, B>(
    self: Effect<A, E, R>,
    that: Effect<A2, E2, R2>,
    f: (a: A, b: A2) => B,
    options?: { readonly concurrent?: boolean | undefined }
  ): Effect<B, E2 | E, R2 | R>
} = internal.zipWith

// -----------------------------------------------------------------------------
// Error handling
// -----------------------------------------------------------------------------

const catch_: {
  <E, A2, E2, R2>(
    f: (e: E) => Effect<A2, E2, R2>
  ): <A, R>(self: Effect<A, E, R>) => Effect<A2 | A, E2, R2 | R>
  <A, E, R, A2, E2, R2>(
    self: Effect<A, E, R>,
    f: (e: E) => Effect<A2, E2, R2>
  ): Effect<A2 | A, E2, R2 | R>
} = internal.catch_

export {
  /**
   * Handles all errors in an effect by providing a fallback effect.
   *
   * **Details**
   *
   * The `catch` function catches any errors that may occur during the
   * execution of an effect and allows you to handle them by specifying a fallback
   * effect. This ensures that the program continues without failing by recovering
   * from errors using the provided fallback logic.
   *
   * **Note**: `catch` only handles recoverable errors. It will not recover
   * from unrecoverable defects.
   *
   * @see {@link catchCause} for a version that can recover from both recoverable and unrecoverable errors.
   *
   * @category error handling
   * @since 4.0.0
   */
  catch_ as catch
}

/**
 * Catches and handles specific errors by their `_tag` field, which is used as a
 * discriminator.
 *
 * **When to use**
 *
 * Use when recovering from one specific tagged error in an effect error
 * channel.
 *
 * **Details**
 *
 * The error type must have a readonly `_tag` field. `catchTag` matches that
 * field and only handles errors with the requested tag.
 *
 * **Example** (Handling a tagged error)
 *
 * ```ts
 * import { Effect } from "effect"
 *
 * class NetworkError {
 *   readonly _tag = "NetworkError"
 *   constructor(readonly message: string) {}
 * }
 *
 * class ValidationError {
 *   readonly _tag = "ValidationError"
 *   constructor(readonly message: string) {}
 * }
 *
 * declare const task: Effect.Effect<string, NetworkError | ValidationError>
 *
 * const program = Effect.catchTag(
 *   task,
 *   "NetworkError",
 *   (error) => Effect.succeed(`Recovered from network error: ${error.message}`)
 * )
 * ```
 *
 * @see {@link catchTags} for handling multiple tagged errors in one call
 * @see {@link catchIf} for recovering from errors that match a predicate
 *
 * @category error handling
 * @since 2.0.0
 */
export const catchTag: {
  <
    const K extends Tags<E> | Arr.NonEmptyReadonlyArray<Tags<E>>,
    E,
    A1,
    E1,
    R1,
    A2 = unassigned,
    E2 = never,
    R2 = never
  >(
    k: K,
    f: (e: ExtractTag<NoInfer<E>, K extends Arr.NonEmptyReadonlyArray<string> ? K[number] : K>) => Effect<A1, E1, R1>,
    orElse?:
      | ((e: ExcludeTag<E, K extends Arr.NonEmptyReadonlyArray<string> ? K[number] : K>) => Effect<A2, E2, R2>)
      | undefined
  ): <A, R>(
    self: Effect<A, E, R>
  ) => Effect<
    A | A1 | Exclude<A2, unassigned>,
    | E1
    | E2
    | (A2 extends unassigned ? ExcludeTag<E, K extends Arr.NonEmptyReadonlyArray<string> ? K[number] : K> : never),
    R | R1 | R2
  >
  <
    A,
    E,
    R,
    const K extends Tags<E> | Arr.NonEmptyReadonlyArray<Tags<E>>,
    R1,
    E1,
    A1,
    A2 = unassigned,
    E2 = never,
    R2 = never
  >(
    self: Effect<A, E, R>,
    k: K,
    f: (e: ExtractTag<E, K extends Arr.NonEmptyReadonlyArray<string> ? K[number] : K>) => Effect<A1, E1, R1>,
    orElse?:
      | ((e: ExcludeTag<E, K extends Arr.NonEmptyReadonlyArray<string> ? K[number] : K>) => Effect<A2, E2, R2>)
      | undefined
  ): Effect<
    A | A1 | Exclude<A2, unassigned>,
    | E1
    | E2
    | (A2 extends unassigned ? ExcludeTag<E, K extends Arr.NonEmptyReadonlyArray<string> ? K[number] : K> : never),
    R | R1 | R2
  >
} = internal.catchTag

/**
 * Handles multiple errors in a single block of code using their `_tag` field.
 *
 * **When to use**
 *
 * Use when one recovery step should handle several tagged error types by
 * matching their readonly `_tag` fields. Pass a handler table whose keys are
 * tags, plus an optional fallback for unmatched errors.
 *
 * The error type must have a readonly `_tag` field to use `catchTag`. This
 * field is used to identify and match errors.
 *
 * **Example** (Handling multiple tagged errors)
 *
 * ```ts
 * import { Data, Effect } from "effect"
 *
 * // Define tagged error types
 * class ValidationError extends Data.TaggedError("ValidationError")<{
 *   message: string
 * }> {}
 *
 * class NetworkError extends Data.TaggedError("NetworkError")<{
 *   statusCode: number
 * }> {}
 *
 * // An effect that might fail with multiple error types
 * declare const program: Effect.Effect<string, ValidationError | NetworkError>
 *
 * // Handle multiple error types at once
 * const handled = Effect.catchTags(program, {
 *   ValidationError: (error) =>
 *     Effect.succeed(`Validation failed: ${error.message}`),
 *   NetworkError: (error) => Effect.succeed(`Network error: ${error.statusCode}`)
 * })
 * ```
 *
 * @category error handling
 * @since 2.0.0
 */
export const catchTags: {
  <
    E,
    Cases extends
      & { [K in Extract<E, { _tag: string }>["_tag"]]+?: ((error: Extract<E, { _tag: K }>) => Effect<any, any, any>) }
      & (unknown extends E ? {} : { [K in Exclude<keyof Cases, Extract<E, { _tag: string }>["_tag"]>]: never }),
    A2 = unassigned,
    E2 = never,
    R2 = never
  >(
    cases: Cases,
    orElse?: ((e: Exclude<E, { _tag: keyof Cases }>) => Effect<A2, E2, R2>) | undefined
  ): <A, R>(
    self: Effect<A, E, R>
  ) => Effect<
    | A
    | Exclude<A2, unassigned>
    | {
      [K in keyof Cases]: Cases[K] extends (...args: Array<any>) => Effect<infer A, any, any> ? A : never
    }[keyof Cases],
    | E2
    | (A2 extends unassigned ? Exclude<E, { _tag: keyof Cases }> : never)
    | {
      [K in keyof Cases]: Cases[K] extends (...args: Array<any>) => Effect<any, infer E, any> ? E : never
    }[keyof Cases],
    | R
    | R2
    | {
      [K in keyof Cases]: Cases[K] extends (...args: Array<any>) => Effect<any, any, infer R> ? R : never
    }[keyof Cases]
  >
  <
    R,
    E,
    A,
    Cases extends
      & { [K in Extract<E, { _tag: string }>["_tag"]]+?: ((error: Extract<E, { _tag: K }>) => Effect<any, any, any>) }
      & (unknown extends E ? {} : { [K in Exclude<keyof Cases, Extract<E, { _tag: string }>["_tag"]>]: never }),
    A2 = unassigned,
    E2 = never,
    R2 = never
  >(
    self: Effect<A, E, R>,
    cases: Cases,
    orElse?: ((e: Exclude<E, { _tag: keyof Cases }>) => Effect<A2, E2, R2>) | undefined
  ): Effect<
    | A
    | Exclude<A2, unassigned>
    | {
      [K in keyof Cases]: Cases[K] extends (...args: Array<any>) => Effect<infer A, any, any> ? A : never
    }[keyof Cases],
    | E2
    | (A2 extends unassigned ? Exclude<E, { _tag: keyof Cases }> : never)
    | {
      [K in keyof Cases]: Cases[K] extends (...args: Array<any>) => Effect<any, infer E, any> ? E : never
    }[keyof Cases],
    | R
    | R2
    | {
      [K in keyof Cases]: Cases[K] extends (...args: Array<any>) => Effect<any, any, infer R> ? R : never
    }[keyof Cases]
  >
} = internal.catchTags

/**
 * Catches a specific reason within a tagged error.
 *
 * **When to use**
 *
 * Use to handle one nested reason inside a tagged error while preserving the
 * parent error shape for unmatched reasons.
 *
 * **Details**
 *
 * Use this to handle nested error causes without removing the parent error
 * from the error channel. The handler receives the unwrapped reason.
 *
 * **Example** (Handling an error reason)
 *
 * ```ts
 * import { Data, Effect } from "effect"
 *
 * class RateLimitError extends Data.TaggedError("RateLimitError")<{
 *   retryAfter: number
 * }> {}
 *
 * class QuotaExceededError extends Data.TaggedError("QuotaExceededError")<{
 *   limit: number
 * }> {}
 *
 * class AiError extends Data.TaggedError("AiError")<{
 *   reason: RateLimitError | QuotaExceededError
 * }> {}
 *
 * declare const program: Effect.Effect<string, AiError>
 *
 * // Handle rate limits specifically
 * const handled = program.pipe(
 *   Effect.catchReason("AiError", "RateLimitError", (reason) =>
 *     Effect.succeed(`Retry after ${reason.retryAfter}s`)
 *   )
 * )
 * ```
 *
 * @see {@link catchReasons} for handling several nested reason tags
 *
 * @category error handling
 * @since 4.0.0
 */
export const catchReason: {
  <
    K extends Tags<E>,
    E,
    RK extends ReasonTags<ExtractTag<NoInfer<E>, K>>,
    A2,
    E2,
    R2,
    A3 = unassigned,
    E3 = never,
    R3 = never
  >(
    errorTag: K,
    reasonTag: RK,
    f: (
      reason: ExtractReason<ExtractTag<NoInfer<E>, K>, RK>,
      error: NarrowReason<ExtractTag<NoInfer<E>, K>, RK>
    ) => Effect<A2, E2, R2>,
    orElse?:
      | ((
        reasons: ExcludeReason<ExtractTag<NoInfer<E>, K>, RK>,
        error: OmitReason<ExtractTag<NoInfer<E>, K>, RK>
      ) => Effect<A3, E3, R3>)
      | undefined
  ): <A, R>(
    self: Effect<A, E, R>
  ) => Effect<
    A | A2 | Exclude<A3, unassigned>,
    ExcludeTag<E, K> | E2 | E3 | (A3 extends unassigned ? ExtractTag<E, K> : never),
    R | R2 | R3
  >
  <
    A,
    E,
    R,
    K extends Tags<E>,
    RK extends ReasonTags<ExtractTag<E, K>>,
    A2,
    E2,
    R2,
    A3 = unassigned,
    E3 = never,
    R3 = never
  >(
    self: Effect<A, E, R>,
    errorTag: K,
    reasonTag: RK,
    f: (reason: ExtractReason<ExtractTag<E, K>, RK>, error: NarrowReason<ExtractTag<E, K>, RK>) => Effect<A2, E2, R2>,
    orElse?:
      | ((reasons: ExcludeReason<ExtractTag<E, K>, RK>, error: OmitReason<ExtractTag<E, K>, RK>) => Effect<A3, E3, R3>)
      | undefined
  ): Effect<
    A | A2 | Exclude<A3, unassigned>,
    ExcludeTag<E, K> | E2 | E3 | (A3 extends unassigned ? ExtractTag<E, K> : never),
    R | R2 | R3
  >
} = internal.catchReason

/**
 * Catches multiple reasons within a tagged error using an object of handlers.
 *
 * **Example** (Handling multiple error reasons)
 *
 * ```ts
 * import { Data, Effect } from "effect"
 *
 * class RateLimitError extends Data.TaggedError("RateLimitError")<{
 *   retryAfter: number
 * }> {}
 *
 * class QuotaExceededError extends Data.TaggedError("QuotaExceededError")<{
 *   limit: number
 * }> {}
 *
 * class AiError extends Data.TaggedError("AiError")<{
 *   reason: RateLimitError | QuotaExceededError
 * }> {}
 *
 * declare const program: Effect.Effect<string, AiError>
 *
 * const handled = program.pipe(
 *   Effect.catchReasons("AiError", {
 *     RateLimitError: (reason) =>
 *       Effect.succeed(`Retry after ${reason.retryAfter}s`),
 *     QuotaExceededError: (reason) =>
 *       Effect.succeed(`Quota exceeded: ${reason.limit}`)
 *   })
 * )
 * ```
 *
 * @category error handling
 * @since 4.0.0
 */
export const catchReasons: {
  <
    K extends Tags<E>,
    E,
    Cases extends {
      [RK in ReasonTags<ExtractTag<NoInfer<E>, K>>]+?: (
        reason: ExtractReason<ExtractTag<NoInfer<E>, K>, RK>,
        error: NarrowReason<ExtractTag<NoInfer<E>, K>, RK>
      ) => Effect<any, any, any>
    },
    A2 = unassigned,
    E2 = never,
    R2 = never
  >(
    errorTag: K,
    cases: Cases,
    orElse?:
      | ((
        reason: ExcludeReason<ExtractTag<NoInfer<E>, K>, Extract<keyof Cases, string>>,
        error: OmitReason<ExtractTag<NoInfer<E>, K>, Extract<keyof Cases, string>>
      ) => Effect<A2, E2, R2>)
      | undefined
  ): <A, R>(
    self: Effect<A, E, R>
  ) => Effect<
    | A
    | Exclude<A2, unassigned>
    | {
      [RK in keyof Cases]: Cases[RK] extends (...args: Array<any>) => Effect<infer A, any, any> ? A : never
    }[keyof Cases],
    | ExcludeTag<E, K>
    | E2
    | (A2 extends unassigned ? ExtractTag<E, K> : never)
    | {
      [RK in keyof Cases]: Cases[RK] extends (...args: Array<any>) => Effect<any, infer E, any> ? E : never
    }[keyof Cases],
    | R
    | R2
    | {
      [RK in keyof Cases]: Cases[RK] extends (...args: Array<any>) => Effect<any, any, infer R> ? R : never
    }[keyof Cases]
  >
  <
    A,
    E,
    R,
    K extends Tags<E>,
    Cases extends {
      [RK in ReasonTags<ExtractTag<E, K>>]+?: (
        reason: ExtractReason<ExtractTag<E, K>, RK>,
        error: NarrowReason<ExtractTag<E, K>, RK>
      ) => Effect<any, any, any>
    },
    A2 = unassigned,
    E2 = never,
    R2 = never
  >(
    self: Effect<A, E, R>,
    errorTag: K,
    cases: Cases,
    orElse?:
      | ((
        reason: ExcludeReason<ExtractTag<NoInfer<E>, K>, Extract<keyof Cases, string>>,
        error: OmitReason<ExtractTag<NoInfer<E>, K>, Extract<keyof Cases, string>>
      ) => Effect<A2, E2, R2>)
      | undefined
  ): Effect<
    | A
    | Exclude<A2, unassigned>
    | {
      [RK in keyof Cases]: Cases[RK] extends (...args: Array<any>) => Effect<infer A, any, any> ? A : never
    }[keyof Cases],
    | ExcludeTag<E, K>
    | E2
    | (A2 extends unassigned ? ExtractTag<E, K> : never)
    | {
      [RK in keyof Cases]: Cases[RK] extends (...args: Array<any>) => Effect<any, infer E, any> ? E : never
    }[keyof Cases],
    | R
    | R2
    | {
      [RK in keyof Cases]: Cases[RK] extends (...args: Array<any>) => Effect<any, any, infer R> ? R : never
    }[keyof Cases]
  >
} = internal.catchReasons

/**
 * Type helper that keeps only error tags whose tagged error contains a tagged `reason` field.
 *
 * **When to use**
 *
 * Use to constrain custom helpers or overloads to parent error tags whose error
 * contains a tagged reason.
 *
 * **Details**
 *
 * The mapped type keeps each parent error tag whose extracted tagged error has
 * at least one reason tag, and removes tags that do not carry tagged reasons.
 *
 * @see {@link unwrapReason} for promoting nested reason errors into the error channel
 * @see {@link catchReason} for handling one nested reason tag
 * @see {@link catchReasons} for handling several nested reason tags
 *
 * @category error handling
 * @since 4.0.0
 */
export type TagsWithReason<E> = {
  [T in Tags<E>]: ReasonTags<ExtractTag<E, T>> extends never ? never : T
}[Tags<E>]

/**
 * Promotes nested reason errors into the Effect error channel, replacing
 * the parent error.
 *
 * **Example** (Extracting the reason from a tagged error)
 *
 * ```ts
 * import { Data, Effect } from "effect"
 *
 * class RateLimitError extends Data.TaggedError("RateLimitError")<{
 *   retryAfter: number
 * }> {}
 *
 * class QuotaExceededError extends Data.TaggedError("QuotaExceededError")<{
 *   limit: number
 * }> {}
 *
 * class AiError extends Data.TaggedError("AiError")<{
 *   reason: RateLimitError | QuotaExceededError
 * }> {}
 *
 * declare const program: Effect.Effect<string, AiError>
 *
 * // Before: Effect<string, AiError>
 * // After:  Effect<string, RateLimitError | QuotaExceededError>
 * const unwrapped = program.pipe(Effect.unwrapReason("AiError"))
 * ```
 *
 * @category error handling
 * @since 4.0.0
 */
export const unwrapReason: {
  <
    K extends TagsWithReason<E>,
    E
  >(
    errorTag: K
  ): <A, R>(self: Effect<A, E, R>) => Effect<A, ExcludeTag<E, K> | ReasonOf<ExtractTag<E, K>>, R>
  <
    A,
    E,
    R,
    K extends TagsWithReason<E>
  >(
    self: Effect<A, E, R>,
    errorTag: K
  ): Effect<A, ExcludeTag<E, K> | ReasonOf<ExtractTag<E, K>>, R>
} = internal.unwrapReason

/**
 * Handles both recoverable and unrecoverable errors by providing a recovery
 * effect.
 *
 * **When to use**
 *
 * Use when recovery needs the full `Cause`, including recoverable failures,
 * defects, and interruptions, instead of only the typed error value.
 *
 * **Details**
 *
 * When to Recover from Defects:
 *
 * Defects are unexpected errors that typically shouldn't be recovered from, as
 * they often indicate serious issues. However, in some cases, such as
 * dynamically loaded plugins, controlled recovery might be needed.
 *
 * **Example** (Recovering from full failure causes)
 *
 * ```ts
 * import { Cause, Console, Effect } from "effect"
 *
 * // An effect that might fail in different ways
 * const program = Effect.die("Something went wrong")
 *
 * // Recover from any cause (including defects)
 * const recovered = Effect.catchCause(program, (cause) => {
 *   if (Cause.hasDies(cause)) {
 *     return Console.log("Caught defect").pipe(
 *       Effect.as("Recovered from defect")
 *     )
 *   }
 *   return Effect.succeed("Unknown error")
 * })
 * ```
 *
 * @category error handling
 * @since 4.0.0
 */
export const catchCause: {
  <E, A2, E2, R2>(
    f: (cause: Cause.Cause<E>) => Effect<A2, E2, R2>
  ): <A, R>(self: Effect<A, E, R>) => Effect<A2 | A, E2, R2 | R>
  <A, E, R, A2, E2, R2>(
    self: Effect<A, E, R>,
    f: (cause: Cause.Cause<E>) => Effect<A2, E2, R2>
  ): Effect<A | A2, E2, R | R2>
} = internal.catchCause

/**
 * Recovers from defects using a provided recovery function.
 *
 * **When to use**
 *
 * Use when you use this sparingly, usually at integration boundaries where defects must be
 * reported or translated for an external system.
 *
 * **Details**
 *
 * `catchDefect` handles unexpected defects, such as thrown exceptions or
 * values passed to `die`, without catching typed failures or interruptions.
 *
 * When to Recover from Defects:
 *
 * Defects are unexpected errors that typically should not be recovered from, as
 * they often indicate serious issues. In some cases, such as dynamically loaded
 * plugins, controlled recovery may be needed.
 *
 * **Example** (Recovering from defects)
 *
 * ```ts
 * import { Console, Effect } from "effect"
 *
 * // An effect that might throw an unexpected error (defect)
 * const program = Effect.sync(() => {
 *   throw new Error("Unexpected error")
 * })
 *
 * // Recover from defects only
 * const recovered = Effect.catchDefect(program, (defect) => {
 *   return Console.log(`Caught defect: ${defect}`).pipe(
 *     Effect.as("Recovered from defect")
 *   )
 * })
 * ```
 *
 * @category error handling
 * @since 4.0.0
 */
export const catchDefect: {
  <A2, E2, R2>(
    f: (defect: unknown) => Effect<A2, E2, R2>
  ): <A, E, R>(self: Effect<A, E, R>) => Effect<A2 | A, E2 | E, R2 | R>
  <A, E, R, A2, E2, R2>(
    self: Effect<A, E, R>,
    f: (defect: unknown) => Effect<A2, E2, R2>
  ): Effect<A | A2, E | E2, R | R2>
} = internal.catchDefect

/**
 * Recovers from specific errors using a `Predicate` or `Refinement`.
 *
 * **When to use**
 *
 * Use when you need to recover from errors that match a condition. Use a
 * `Refinement` for type narrowing or a `Predicate` for simple boolean
 * matching. Non-matching errors re-fail with the original cause. Defects and
 * interrupts are not caught.
 *
 * **Example** (Recovering when a predicate matches)
 *
 * ```ts
 * import { Data, Effect, Filter } from "effect"
 *
 * class NotFound extends Data.TaggedError("NotFound")<{ id: string }> {}
 *
 * const program = Effect.fail(new NotFound({ id: "user-1" }))
 *
 * // With a refinement
 * const recovered = program.pipe(
 *   Effect.catchIf(
 *     (error): error is NotFound => error._tag === "NotFound",
 *     (error) => Effect.succeed(`missing:${error.id}`)
 *   )
 * )
 *
 * // With a Filter
 * const recovered2 = program.pipe(
 *   Effect.catchFilter(
 *     Filter.tagged("NotFound"),
 *     (error) => Effect.succeed(`missing:${error.id}`)
 *   )
 * )
 * ```
 *
 * @category error handling
 * @since 2.0.0
 */
export const catchIf: {
  <E, EB extends E, A2, E2, R2, A3 = unassigned, E3 = never, R3 = never>(
    refinement: Predicate.Refinement<NoInfer<E>, EB>,
    f: (e: EB) => Effect<A2, E2, R2>,
    orElse?: ((e: Exclude<E, EB>) => Effect<A3, E3, R3>) | undefined
  ): <A, R>(
    self: Effect<A, E, R>
  ) => Effect<A | A2 | Exclude<A3, unassigned>, E2 | E3 | (A3 extends unassigned ? Exclude<E, EB> : never), R | R2 | R3>
  <E, A2, E2, R2, A3 = unassigned, E3 = never, R3 = never>(
    predicate: Predicate.Predicate<NoInfer<E>>,
    f: (e: NoInfer<E>) => Effect<A2, E2, R2>,
    orElse?: ((e: NoInfer<E>) => Effect<A3, E3, R3>) | undefined
  ): <A, R>(
    self: Effect<A, E, R>
  ) => Effect<A | A2 | Exclude<A3, unassigned>, E2 | E3 | (A3 extends unassigned ? E : never), R | R2 | R3>
  <A, E, R, EB extends E, A2, E2, R2, A3 = unassigned, E3 = never, R3 = never>(
    self: Effect<A, E, R>,
    refinement: Predicate.Refinement<E, EB>,
    f: (e: EB) => Effect<A2, E2, R2>,
    orElse?: ((e: Exclude<E, EB>) => Effect<A3, E3, R3>) | undefined
  ): Effect<A | A2 | Exclude<A3, unassigned>, E2 | E3 | (A3 extends unassigned ? Exclude<E, EB> : never), R | R2 | R3>
  <A, E, R, A2, E2, R2, A3 = unassigned, E3 = never, R3 = never>(
    self: Effect<A, E, R>,
    predicate: Predicate.Predicate<E>,
    f: (e: E) => Effect<A2, E2, R2>,
    orElse?: ((e: E) => Effect<A3, E3, R3>) | undefined
  ): Effect<A | A2 | Exclude<A3, unassigned>, E2 | E3 | (A3 extends unassigned ? E : never), R | R2 | R3>
} = internal.catchIf

/**
 * Recovers from specific errors using a `Filter`.
 *
 * **When to use**
 *
 * Use to recover from typed `Effect` errors with a reusable `Filter` when
 * matching can also narrow or transform the error before choosing the recovery
 * effect.
 *
 * **Details**
 *
 * The filter runs on typed failures extracted from the `Cause`. Successful
 * filter results are passed to `f`; failed filter results are passed to
 * `orElse` when provided. Without `orElse`, the original failure cause is
 * preserved.
 *
 * @see {@link catchIf} for predicate-based recovery from typed errors
 * @see {@link catchTag} for recovering from a single tagged error
 * @see {@link catchTags} for recovering from several tagged errors
 * @see {@link catchCauseFilter} for filtering full causes instead of typed errors
 *
 * @category error handling
 * @since 4.0.0
 */
export const catchFilter: {
  <E, EB, A2, E2, R2, X, A3 = unassigned, E3 = never, R3 = never>(
    filter: Filter.Filter<NoInfer<E>, EB, X>,
    f: (e: EB) => Effect<A2, E2, R2>,
    orElse?: ((e: X) => Effect<A3, E3, R3>) | undefined
  ): <A, R>(
    self: Effect<A, E, R>
  ) => Effect<A | A2 | Exclude<A3, unassigned>, E2 | E3 | (A3 extends unassigned ? X : never), R | R2 | R3>
  <A, E, R, EB, A2, E2, R2, X, A3 = unassigned, E3 = never, R3 = never>(
    self: Effect<A, E, R>,
    filter: Filter.Filter<NoInfer<E>, EB, X>,
    f: (e: EB) => Effect<A2, E2, R2>,
    orElse?: ((e: X) => Effect<A3, E3, R3>) | undefined
  ): Effect<A | A2 | Exclude<A3, unassigned>, E2 | E3 | (A3 extends unassigned ? X : never), R | R2 | R3>
} = internal.catchFilter

/**
 * Catches `NoSuchElementError` failures and converts them to `Option.none`.
 *
 * **When to use**
 *
 * Use to convert `NoSuchElementError` failures into `Option.none`.
 *
 * **Details**
 *
 * Success values become `Option.some`, `NoSuchElementError` becomes
 * `Option.none`, and all other errors are preserved.
 *
 * **Example** (Recovering from missing Option values)
 *
 * ```ts
 * import { Effect, Option } from "effect"
 *
 * const some = Effect.fromNullishOr(1).pipe(Effect.catchNoSuchElement)
 * const none = Effect.fromNullishOr(null).pipe(Effect.catchNoSuchElement)
 *
 * Effect.runPromise(some).then(console.log) // { _id: 'Option', _tag: 'Some', value: 1 }
 * Effect.runPromise(none).then(console.log) // { _id: 'Option', _tag: 'None' }
 * ```
 *
 * @see {@link fromOption} for converting `Option.none` into `NoSuchElementError`
 * @see {@link fromNullishOr} for converting nullish values into `NoSuchElementError`
 * @see {@link option} for converting any failure into `Option.none`
 *
 * @category error handling
 * @since 4.0.0
 */
export const catchNoSuchElement: <A, E, R>(
  self: Effect<A, E, R>
) => Effect<Option<A>, Exclude<E, Cause.NoSuchElementError>, R> = internal.catchNoSuchElement

/**
 * Recovers from specific failures based on a predicate.
 *
 * **When to use**
 *
 * Use to recover from full causes selected by a predicate.
 *
 * **Details**
 *
 * This function allows you to conditionally catch and recover from failures
 * that match a specific predicate. This is useful when you want to handle
 * only certain types of errors while letting others propagate.
 *
 * **Example** (Recovering from selected causes)
 *
 * ```ts
 * import { Cause, Console, Effect } from "effect"
 *
 * const httpRequest = Effect.fail("Network Error")
 *
 * // Only catch network-related failures
 * const program = Effect.catchCauseIf(
 *   httpRequest,
 *   Cause.hasFails,
 *   (cause) =>
 *     Effect.gen(function*() {
 *       yield* Console.log(`Caught network error: ${Cause.squash(cause)}`)
 *       return "Fallback response"
 *     })
 * )
 *
 * Effect.runPromise(program).then(console.log)
 * // Output: "Caught network error: Network Error"
 * // Then: "Fallback response"
 * ```
 *
 * @see {@link catchCause} for recovering from every cause
 * @see {@link catchCauseFilter} for selecting full causes with a `Filter`
 * @see {@link catchIf} for predicate-based recovery from typed errors
 *
 * @category error handling
 * @since 4.0.0
 */
export const catchCauseIf: {
  <E, B, E2, R2>(
    predicate: Predicate.Predicate<Cause.Cause<E>>,
    f: (cause: Cause.Cause<E>) => Effect<B, E2, R2>
  ): <A, R>(self: Effect<A, E, R>) => Effect<A | B, E | E2, R | R2>
  <A, E, R, B, E2, R2>(
    self: Effect<A, E, R>,
    predicate: Predicate.Predicate<Cause.Cause<E>>,
    f: (cause: Cause.Cause<E>) => Effect<B, E2, R2>
  ): Effect<A | B, E | E2, R | R2>
} = internal.catchCauseIf

/**
 * Recovers from specific failures based on a `Filter`.
 *
 * **When to use**
 *
 * Use when you need to recover only from causes selected by a `Filter`, and the
 * recovery needs both the selected value and the original `Cause`.
 *
 * **Details**
 *
 * The filter is applied to the full `Cause`. When it succeeds, the handler
 * receives the selected value and the original cause. When it fails, the effect
 * re-fails with the residual cause returned by the filter.
 *
 * @see {@link catchCauseIf} for predicate-based cause selection
 * @see {@link catchFilter} for filtering typed error values instead of full causes
 * @see {@link catchCause} for recovering from every cause without filtering
 *
 * @category error handling
 * @since 4.0.0
 */
export const catchCauseFilter: {
  <E, B, E2, R2, EB, X extends Cause.Cause<any>>(
    filter: Filter.Filter<Cause.Cause<E>, EB, X>,
    f: (failure: EB, cause: Cause.Cause<E>) => Effect<B, E2, R2>
  ): <A, R>(self: Effect<A, E, R>) => Effect<A | B, Cause.Cause.Error<X> | E2, R | R2>
  <A, E, R, B, E2, R2, EB, X extends Cause.Cause<any>>(
    self: Effect<A, E, R>,
    filter: Filter.Filter<Cause.Cause<E>, EB, X>,
    f: (failure: EB, cause: Cause.Cause<E>) => Effect<B, E2, R2>
  ): Effect<A | B, Cause.Cause.Error<X> | E2, R | R2>
} = internal.catchCauseFilter

/**
 * Transforms the failure value of an effect without changing its success value.
 *
 * **When to use**
 *
 * Use to translate typed failures while leaving successful values unchanged.
 *
 * **Details**
 *
 * Only the failure channel is transformed. The success channel and requirements
 * are preserved.
 *
 * **Example** (Transforming the error channel)
 *
 * ```ts
 * import { Data, Effect } from "effect"
 *
 * class TaskError extends Data.TaggedError("TaskError")<{ readonly message: string }> {}
 *
 * //      ┌─── Effect<number, string, never>
 * //      ▼
 * const simulatedTask = Effect.fail("Oh no!").pipe(Effect.as(1))
 *
 * //      ┌─── Effect<number, TaskError, never>
 * //      ▼
 * const mapped = Effect.mapError(
 *   simulatedTask,
 *   (message) => new TaskError({ message })
 * )
 * ```
 *
 * @see {@link map} for a version that operates on the success channel.
 * @see {@link mapBoth} for a version that operates on both channels.
 *
 * @category error handling
 * @since 2.0.0
 */
export const mapError: {
  <E, E2>(f: (e: E) => E2): <A, R>(self: Effect<A, E, R>) => Effect<A, E2, R>
  <A, E, R, E2>(self: Effect<A, E, R>, f: (e: E) => E2): Effect<A, E2, R>
} = internal.mapError

/**
 * Applies transformations to both the success and error channels of an effect.
 *
 * **When to use**
 *
 * Use to transform both success and failure values without changing whether the
 * effect succeeds or fails.
 *
 * **Details**
 *
 * This function takes two map functions as arguments: one for the error channel
 * and one for the success channel. You can use it when you want to modify both
 * the error and the success values without altering the overall success or
 * failure status of the effect.
 *
 * **Example** (Transforming success and failure channels)
 *
 * ```ts
 * import { Data, Effect } from "effect"
 *
 * class TaskError extends Data.TaggedError("TaskError")<{ readonly message: string }> {}
 *
 * //      ┌─── Effect<number, string, never>
 * //      ▼
 * const simulatedTask = Effect.fail("Oh no!").pipe(Effect.as(1))
 *
 * //      ┌─── Effect<boolean, TaskError, never>
 * //      ▼
 * const modified = Effect.mapBoth(simulatedTask, {
 *   onFailure: (message) => new TaskError({ message }),
 *   onSuccess: (n) => n > 0
 * })
 * ```
 *
 * @see {@link map} for a version that operates on the success channel.
 * @see {@link mapError} for a version that operates on the error channel.
 *
 * @category mapping
 * @since 2.0.0
 */
export const mapBoth: {
  <E, E2, A, A2>(
    options: { readonly onFailure: (e: E) => E2; readonly onSuccess: (a: A) => A2 }
  ): <R>(self: Effect<A, E, R>) => Effect<A2, E2, R>
  <A, E, R, E2, A2>(
    self: Effect<A, E, R>,
    options: { readonly onFailure: (e: E) => E2; readonly onSuccess: (a: A) => A2 }
  ): Effect<A2, E2, R>
} = internal.mapBoth

/**
 * Converts typed failures from the error channel into defects, removing the
 * error type from the returned effect.
 *
 * **When to use**
 *
 * Use when a typed failure represents an unrecoverable bug or invalid
 * state and should not be handled as a recoverable error.
 *
 * **Example** (Converting typed failures into defects)
 *
 * ```ts
 * import { Data, Effect } from "effect"
 *
 * class DivideByZeroError extends Data.TaggedError("DivideByZeroError")<{}> {}
 *
 * const divide = (a: number, b: number) =>
 *   b === 0
 *     ? Effect.fail(new DivideByZeroError())
 *     : Effect.succeed(a / b)
 *
 * //      ┌─── Effect<number, never, never>
 * //      ▼
 * const program = Effect.orDie(divide(1, 0))
 *
 * Effect.runPromise(program).catch(console.error)
 * // Output:
 * // (FiberFailure) DivideByZeroError
 * //   ...stack trace...
 * ```
 *
 * @category converting failures to defects
 * @since 2.0.0
 */
export const orDie: <A, E, R>(self: Effect<A, E, R>) => Effect<A, never, R> = internal.orDie

/**
 * Runs an effectful operation when the source effect fails, while preserving
 * the original failure when the operation succeeds.
 *
 * **Details**
 *
 * Use this for logging, metrics, or other failure-side observations. If the
 * operation passed to `tapError` fails, that error is also represented in the
 * returned effect's error channel.
 *
 * **Example** (Running effects on failure)
 *
 * ```ts
 * import { Console, Effect } from "effect"
 *
 * // Simulate a task that fails with an error
 * const task: Effect.Effect<number, string> = Effect.fail("NetworkError")
 *
 * // Use tapError to log the error message when the task fails
 * const tapping = Effect.tapError(
 *   task,
 *   (error) => Console.log(`expected error: ${error}`)
 * )
 *
 * Effect.runFork(tapping)
 * // Output:
 * // expected error: NetworkError
 * ```
 *
 * @category sequencing
 * @since 2.0.0
 */
export const tapError: {
  <E, X, E2, R2>(
    f: (e: NoInfer<E>) => Effect<X, E2, R2>
  ): <A, R>(self: Effect<A, E, R>) => Effect<A, E | E2, R2 | R>
  <A, E, R, X, E2, R2>(
    self: Effect<A, E, R>,
    f: (e: E) => Effect<X, E2, R2>
  ): Effect<A, E | E2, R | R2>
} = internal.tapError

/**
 * Runs an effectful handler when a failure's `_tag` matches.
 *
 * **Details**
 *
 * Use this with tagged-union errors to perform side effects for one tag or a
 * list of tags. When the handler succeeds, the original failure is preserved;
 * if the handler fails, its error is also included in the returned effect.
 *
 * **Example** (Running effects for tagged failures)
 *
 * ```ts
 * import { Console, Data, Effect } from "effect"
 *
 * class NetworkError extends Data.TaggedError("NetworkError")<{
 *   statusCode: number
 * }> {}
 *
 * class ValidationError extends Data.TaggedError("ValidationError")<{
 *   field: string
 * }> {}
 *
 * const task: Effect.Effect<number, NetworkError | ValidationError> =
 *   Effect.fail(new NetworkError({ statusCode: 504 }))
 *
 * const program = Effect.tapErrorTag(task, "NetworkError", (error) =>
 *   Console.log(`expected error: ${error.statusCode}`)
 * )
 *
 * Effect.runPromiseExit(program)
 * // Output:
 * // expected error: 504
 * ```
 *
 * @category sequencing
 * @since 2.0.0
 */
export const tapErrorTag: {
  <const K extends Tags<E> | Arr.NonEmptyReadonlyArray<Tags<E>>, E, A1, E1, R1>(
    k: K,
    f: (e: ExtractTag<NoInfer<E>, K extends Arr.NonEmptyReadonlyArray<string> ? K[number] : K>) => Effect<A1, E1, R1>
  ): <A, R>(self: Effect<A, E, R>) => Effect<A, E | E1, R1 | R>
  <
    A,
    E,
    R,
    const K extends Tags<E> | Arr.NonEmptyReadonlyArray<Tags<E>>,
    R1,
    E1,
    A1
  >(
    self: Effect<A, E, R>,
    k: K,
    f: (e: ExtractTag<E, K extends Arr.NonEmptyReadonlyArray<string> ? K[number] : K>) => Effect<A1, E1, R1>
  ): Effect<A, E | E1, R | R1>
} = internal.tapErrorTag

/**
 * Runs an effectful operation with the full `Cause` when the source effect
 * fails.
 *
 * **Details**
 *
 * Use this to log or inspect typed failures, defects, and interruptions. When
 * the operation succeeds, the original cause is preserved. If the operation
 * fails, its error is also represented in the returned effect.
 *
 * **Example** (Observing full failure causes)
 *
 * ```ts
 * import { Cause, Console, Effect } from "effect"
 *
 * const task = Effect.fail("Something went wrong")
 *
 * const program = Effect.tapCause(
 *   task,
 *   (cause) => Console.log(`Logging cause: ${Cause.squash(cause)}`)
 * )
 *
 * Effect.runPromiseExit(program).then(console.log)
 * // Output: "Logging cause: Error: Something went wrong"
 * // Then: { _id: 'Exit', _tag: 'Failure', cause: ... }
 * ```
 *
 * @category sequencing
 * @since 4.0.0
 */
export const tapCause: {
  <E, X, E2, R2>(
    f: (cause: Cause.Cause<NoInfer<E>>) => Effect<X, E2, R2>
  ): <A, R>(self: Effect<A, E, R>) => Effect<A, E | E2, R2 | R>
  <A, E, R, X, E2, R2>(
    self: Effect<A, E, R>,
    f: (cause: Cause.Cause<E>) => Effect<X, E2, R2>
  ): Effect<A, E | E2, R | R2>
} = internal.tapCause

/**
 * Executes a side effect conditionally when a failed effect's cause matches a predicate.
 *
 * **Details**
 *
 * This function allows you to tap into the cause of an effect's failure only when
 * the cause matches a specific predicate. This is useful for conditional logging,
 * monitoring, or other side effects based on the type of failure.
 *
 * **Example** (Observing selected failure causes)
 *
 * ```ts
 * import { Cause, Console, Effect } from "effect"
 *
 * const task = Effect.fail("Network timeout")
 *
 * // Only log causes that contain failures (not interrupts or defects)
 * const program = Effect.tapCauseIf(
 *   task,
 *   Cause.hasFails,
 *   (cause) => Console.log(`Logging failure cause: ${Cause.squash(cause)}`)
 * )
 *
 * Effect.runPromiseExit(program).then(console.log)
 * // Output: "Logging failure cause: Network timeout"
 * // Then: { _id: 'Exit', _tag: 'Failure', cause: ... }
 * ```
 *
 * @category sequencing
 * @since 4.0.0
 */
export const tapCauseIf: {
  <E, B, E2, R2>(
    predicate: Predicate.Predicate<Cause.Cause<E>>,
    f: (cause: Cause.Cause<E>) => Effect<B, E2, R2>
  ): <A, R>(self: Effect<A, E, R>) => Effect<A, E | E2, R | R2>
  <A, E, R, B, E2, R2>(
    self: Effect<A, E, R>,
    predicate: Predicate.Predicate<Cause.Cause<E>>,
    f: (cause: Cause.Cause<E>) => Effect<B, E2, R2>
  ): Effect<A, E | E2, R | R2>
} = internal.tapCauseIf

/**
 * Executes a side effect conditionally when a failed effect's cause passes a filter.
 *
 * **When to use**
 *
 * Use when you need to observe only failure causes selected by a `Filter`, and
 * the side effect needs both the selected value and the original `Cause`.
 *
 * **Details**
 *
 * A successful filter result runs the side effect with the selected value and
 * original cause. A failed filter result skips the side effect and preserves the
 * original cause.
 *
 * @see {@link tapCauseIf} for selecting causes with a boolean predicate
 * @see {@link tapCause} for observing every failure cause
 * @see {@link catchCauseFilter} for recovering from selected causes instead of only observing them
 *
 * @category sequencing
 * @since 4.0.0
 */
export const tapCauseFilter: {
  <E, B, E2, R2, EB, X extends Cause.Cause<any>>(
    filter: Filter.Filter<Cause.Cause<E>, EB, X>,
    f: (a: EB, cause: Cause.Cause<E>) => Effect<B, E2, R2>
  ): <A, R>(self: Effect<A, E, R>) => Effect<A, E | E2, R | R2>
  <A, E, R, B, E2, R2, EB, X extends Cause.Cause<any>>(
    self: Effect<A, E, R>,
    filter: Filter.Filter<Cause.Cause<E>, EB, X>,
    f: (a: EB, cause: Cause.Cause<E>) => Effect<B, E2, R2>
  ): Effect<A, E | E2, R | R2>
} = internal.tapCauseFilter

/**
 * Runs an effectful operation when the source effect dies with a defect.
 *
 * **Details**
 *
 * Use this for diagnostics such as logging unexpected thrown exceptions or
 * values passed to `die`. Recoverable failures are not handled. When the
 * operation succeeds, the original defect is preserved; if the operation fails,
 * its error is also represented in the returned effect.
 *
 * **Example** (Observing defects)
 *
 * ```ts
 * import { Console, Effect } from "effect"
 *
 * // Simulate a task that fails with a recoverable error
 * const task1: Effect.Effect<number, string> = Effect.fail("NetworkError")
 *
 * // tapDefect won't log anything because NetworkError is not a defect
 * const tapping1 = Effect.tapDefect(
 *   task1,
 *   (cause) => Console.log(`defect: ${cause}`)
 * )
 *
 * Effect.runFork(tapping1)
 * // No Output
 *
 * // Simulate a severe failure in the system
 * const task2: Effect.Effect<number> = Effect.die(
 *   "Something went wrong"
 * )
 *
 * // Log the defect using tapDefect
 * const tapping2 = Effect.tapDefect(
 *   task2,
 *   (cause) => Console.log(`defect: ${cause}`)
 * )
 *
 * Effect.runFork(tapping2)
 * // Output:
 * // defect: RuntimeException: Something went wrong
 * //   ... stack trace ...
 * ```
 *
 * @category sequencing
 * @since 2.0.0
 */
export const tapDefect: {
  <E, B, E2, R2>(f: (defect: unknown) => Effect<B, E2, R2>): <A, R>(self: Effect<A, E, R>) => Effect<A, E | E2, R | R2>
  <A, E, R, B, E2, R2>(self: Effect<A, E, R>, f: (defect: unknown) => Effect<B, E2, R2>): Effect<A, E | E2, R | R2>
} = internal.tapDefect

/**
 * Retries an effect until it succeeds, discarding failures.
 *
 * **Details**
 *
 * Yields between attempts so other fibers can run.
 *
 * **Example** (Retrying until success)
 *
 * ```ts
 * import { Console, Effect } from "effect"
 *
 * let attempts = 0
 *
 * const flaky = Effect.gen(function*() {
 *   attempts++
 *   yield* Console.log(`Attempt ${attempts}`)
 *   if (attempts < 3) {
 *     return yield* Effect.fail("Not ready")
 *   }
 *   return "Ready"
 * })
 *
 * const program = Effect.eventually(flaky)
 *
 * Effect.runPromise(program).then(console.log)
 * // Output:
 * // Attempt 1
 * // Attempt 2
 * // Attempt 3
 * // Ready
 * ```
 *
 * @category repetition / recursion
 * @since 2.0.0
 */
export const eventually: <A, E, R>(self: Effect<A, E, R>) => Effect<A, never, R> = internal.eventually

// -----------------------------------------------------------------------------
// Error Handling
// -----------------------------------------------------------------------------

/**
 * Type helpers for retrying effects.
 *
 * @since 2.0.0
 */
export declare namespace Retry {
  /**
   * Computes the result type of `Effect.retry` from the original effect and retry options.
   *
   * @category error handling
   * @since 2.0.0
   */
  export type Return<R, E, A, O extends Options<E>> = Effect<
    A,
    | (O extends { schedule: Schedule<infer _O, infer _I, infer _E1, infer _R> } ? E
      : O extends { times: number } ? E
      : O extends { until: Predicate.Refinement<E, infer E2> } ? E2
      : O extends { while: Predicate.Refinement<E, infer E2> } ? Exclude<E, E2>
      : E)
    | (O extends { schedule: Schedule<infer _O, infer _I, infer E, infer _R> } ? E
      : never)
    | (O extends { while: (...args: Array<any>) => Effect<infer _A, infer E, infer _R> } ? E
      : never)
    | (O extends { until: (...args: Array<any>) => Effect<infer _A, infer E, infer _R> } ? E
      : never),
    | R
    | (O extends { schedule: Schedule<infer _O, infer _I, infer _E1, infer R> } ? R
      : never)
    | (O extends { while: (...args: Array<any>) => Effect<infer _A, infer _E, infer R> } ? R
      : never)
    | (O extends { until: (...args: Array<any>) => Effect<infer _A, infer _E, infer R> } ? R
      : never)
  > extends infer Z ? Z
    : never

  /**
   * Options that control whether and how a failing effect is retried.
   *
   * @category error handling
   * @since 2.0.0
   */
  export interface Options<E> {
    while?: ((error: E) => boolean | Effect<boolean, any, any>) | undefined
    until?: ((error: E) => boolean | Effect<boolean, any, any>) | undefined
    times?: number | undefined
    schedule?: Schedule<any, E, any, any> | undefined
  }
}

/**
 * Retries typed failures from an effect according to a retry policy.
 *
 * **When to use**
 *
 * Use when typed failures may be transient, such as network issues or
 * temporary resource unavailability.
 *
 * **Details**
 *
 * The policy can be a `Schedule`, a schedule builder, or a `Retry.Options`
 * object using `schedule`, `times`, `while`, or `until`. If a retry eventually
 * succeeds, the returned effect succeeds with that value. If the policy stops
 * while the effect is still failing, the last failure is propagated.
 *
 * **Gotchas**
 *
 * The source effect is always evaluated once before any retry policy is
 * applied. For example, `Schedule.recurs(3)` allows up to three retries after
 * the initial attempt.
 *
 * Defects and interruptions are not retried.
 *
 * **Example** (Retrying with a schedule)
 *
 * ```ts
 * import { Data, Effect, Schedule } from "effect"
 *
 * class AttemptError extends Data.TaggedError("AttemptError")<{ readonly attempt: number }> {}
 *
 * let attempt = 0
 * const task = Effect.callback<string, AttemptError>((resume) => {
 *   attempt++
 *   if (attempt <= 2) {
 *     resume(Effect.fail(new AttemptError({ attempt })))
 *   } else {
 *     resume(Effect.succeed("Success!"))
 *   }
 * })
 *
 * const policy = Schedule.addDelay(Schedule.recurs(5), () => Effect.succeed("100 millis"))
 * const program = Effect.retry(task, policy)
 *
 * Effect.runPromise(program).then(console.log)
 * // Output: "Success!" (after 2 retries)
 * ```
 *
 * @see {@link retryOrElse} for a version that allows you to run a fallback.
 * @see {@link repeat} if your retry condition is based on successful outcomes rather than errors.
 * @category error handling
 * @since 2.0.0
 */
export const retry: {
  <E, O extends Retry.Options<E>>(options: O): <A, R>(self: Effect<A, E, R>) => Retry.Return<R, E, A, O>
  <B, E, Error, Env>(
    policy: Schedule<B, NoInfer<E>, Error, Env>
  ): <A, R>(self: Effect<A, E, R>) => Effect<A, E | Error, R | Env>
  <B, E, Error, Env>(
    builder: (
      $: <O, SE, R>(_: Schedule<O, NoInfer<E>, SE, R>) => Schedule<O, E, SE, R>
    ) => Schedule<B, NoInfer<E>, Error, Env>
  ): <A, R>(self: Effect<A, E, R>) => Effect<A, E | Error, R | Env>
  <A, E, R, O extends Retry.Options<E>>(self: Effect<A, E, R>, options: O): Retry.Return<R, E, A, O>
  <A, E, R, B, Error, Env>(
    self: Effect<A, E, R>,
    policy: Schedule<B, NoInfer<E>, Error, Env>
  ): Effect<A, E | Error, R | Env>
  <A, E, R, B, Error, Env>(
    self: Effect<A, E, R>,
    builder: (
      $: <O, SE, R>(_: Schedule<O, NoInfer<E>, SE, R>) => Schedule<O, E, SE, R>
    ) => Schedule<B, NoInfer<E>, Error, Env>
  ): Effect<A, E | Error, R | Env>
} = internalSchedule.retry

/**
 * Retries a failing effect and runs a fallback effect if retries are exhausted.
 *
 * **When to use**
 *
 * Use when you want to handle failures gracefully by specifying an alternative
 * action after repeated failures.
 *
 * **Details**
 *
 * The `Effect.retryOrElse` function attempts to retry a failing effect multiple
 * times according to a defined {@link Schedule} policy.
 *
 * If the retries are exhausted and the effect still fails, it runs a fallback
 * effect instead.
 *
 * **Example** (Falling back after retries are exhausted)
 *
 * ```ts
 * import { Console, Data, Effect, Schedule } from "effect"
 *
 * class NetworkTimeoutError extends Data.TaggedError("NetworkTimeoutError")<{}> {}
 *
 * let attempt = 0
 * const networkRequest = Effect.gen(function*() {
 *   attempt++
 *   yield* Console.log(`Network attempt ${attempt}`)
 *   if (attempt < 3) {
 *     return yield* Effect.fail(new NetworkTimeoutError())
 *   }
 *   return "Network data"
 * })
 *
 * // Retry up to 2 times, then fall back to cached data
 * const program = Effect.retryOrElse(
 *   networkRequest,
 *   Schedule.recurs(2),
 *   (error, retryCount) =>
 *     Effect.gen(function*() {
 *       yield* Console.log(`All ${retryCount} retries failed, using cache`)
 *       return "Cached data"
 *     })
 * )
 *
 * Effect.runPromise(program).then(console.log)
 * // Output:
 * // Network attempt 1
 * // Network attempt 2
 * // Network attempt 3
 * // Network data
 * ```
 *
 * @see {@link retry} for a version that does not run a fallback effect.
 * @category error handling
 * @since 2.0.0
 */
export const retryOrElse: {
  <A1, E, E1, R1, A2, E2, R2>(
    policy: Schedule<A1, NoInfer<E>, E1, R1>,
    orElse: (e: NoInfer<E>, out: A1) => Effect<A2, E2, R2>
  ): <A, R>(self: Effect<A, E, R>) => Effect<A | A2, E1 | E2, R | R1 | R2>
  <A, E, R, A1, E1, R1, A2, E2, R2>(
    self: Effect<A, E, R>,
    policy: Schedule<A1, NoInfer<E>, E1, R1>,
    orElse: (e: NoInfer<E>, out: A1) => Effect<A2, E2, R2>
  ): Effect<A | A2, E1 | E2, R | R1 | R2>
} = internalSchedule.retryOrElse

/**
 * Exposes an effect's full failure cause in the error channel as `Cause<E>`.
 *
 * **Details**
 *
 * Use `sandbox` when downstream error handling needs to distinguish typed
 * failures, defects, and interruptions. Use `unsandbox` to restore the original
 * typed error channel after cause-level handling.
 *
 * **Example** (Exposing failures as causes)
 *
 * ```ts
 * import { Cause, Effect } from "effect"
 *
 * const task = Effect.fail("Something went wrong")
 *
 * // Sandbox exposes the full cause as the error type
 * const program = Effect.gen(function*() {
 *   const result = yield* Effect.flip(Effect.sandbox(task))
 *   return `Caught cause: ${Cause.squash(result)}`
 * })
 *
 * Effect.runPromise(program).then(console.log)
 * // Output: "Caught cause: Something went wrong"
 * ```
 *
 * @category error handling
 * @since 2.0.0
 */
export const sandbox: <A, E, R>(
  self: Effect<A, E, R>
) => Effect<A, Cause.Cause<E>, R> = internal.sandbox

/**
 * Discards both the success and failure values of an effect.
 *
 * **When to use**
 *
 * Use when an effect should run for its side effects while both success and
 * failure values are discarded.
 *
 * Use the `log` option to emit the full {@link Cause} when the effect fails,
 * and `message` to prepend a custom log message.
 *
 * **Example** (Discarding success and failure values)
 *
 * ```ts
 * import { Effect } from "effect"
 *
 * //      ┌─── Effect<number, string, never>
 * //      ▼
 * const task = Effect.fail("Uh oh!").pipe(Effect.as(5))
 *
 * //      ┌─── Effect<void, never, never>
 * //      ▼
 * const program = task.pipe(Effect.ignore)
 * ```
 *
 * **Example** (Logging failures while ignoring results)
 *
 * ```ts
 * import { Effect } from "effect"
 *
 * const task = Effect.fail("Uh oh!")
 *
 * const program = task.pipe(Effect.ignore({ log: true }))
 * const programWarn = task.pipe(Effect.ignore({ log: "Warn", message: "Ignoring task failure" }))
 * ```
 *
 * @category error handling
 * @since 2.0.0
 */
export const ignore: <
  Arg extends Effect<any, any, any> | {
    readonly log?: boolean | Severity | undefined
    readonly message?: string | undefined
  } | undefined = {
    readonly log?: boolean | Severity | undefined
    readonly message?: string | undefined
  }
>(
  effectOrOptions?: Arg,
  options?: {
    readonly log?: boolean | Severity | undefined
    readonly message?: string | undefined
  } | undefined
) => [Arg] extends [Effect<infer _A, infer _E, infer _R>] ? Effect<void, never, _R>
  : <A, E, R>(self: Effect<A, E, R>) => Effect<void, never, R> = internal.ignore

/**
 * Ignores the effect's failure cause, including defects and interruptions.
 *
 * **Details**
 *
 * Use the `log` option to emit the full {@link Cause} when the effect fails,
 * and `message` to prepend a custom log message.
 *
 * **Example** (Ignoring failures and logging causes)
 *
 * ```ts
 * import { Effect } from "effect"
 *
 * const task = Effect.fail("boom")
 *
 * const program = task.pipe(Effect.ignoreCause)
 * const programLog = task.pipe(Effect.ignoreCause({ log: true, message: "Ignoring failure cause" }))
 * ```
 *
 * @category error handling
 * @since 4.0.0
 */
export const ignoreCause: <
  Arg extends Effect<any, any, any> | {
    readonly log?: boolean | Severity | undefined
    readonly message?: string | undefined
  } | undefined = {
    readonly log?: boolean | Severity | undefined
    readonly message?: string | undefined
  }
>(
  effectOrOptions?: Arg,
  options?: {
    readonly log?: boolean | Severity | undefined
    readonly message?: string | undefined
  } | undefined
) => [Arg] extends [Effect<infer _A, infer _E, infer _R>] ? Effect<void, never, _R>
  : <A, E, R>(self: Effect<A, E, R>) => Effect<void, never, R> = internal.ignoreCause

/**
 * Applies an `ExecutionPlan` to an effect, retrying with step-provided resources
 * until it succeeds or the plan is exhausted.
 *
 * **Details**
 *
 * Each attempt updates `ExecutionPlan.CurrentMetadata` (attempt and step index),
 * and retry timing is derived per step (the first attempt uses the remaining
 * attempts schedule; later retries apply the step schedule at least once).
 *
 * **Example** (Retrying with an execution plan)
 *
 * ```ts
 * import { Context, Effect, ExecutionPlan, Layer } from "effect"
 *
 * const Endpoint = Context.Service<{ url: string }>("Endpoint")
 *
 * const fetchUrl = Effect.gen(function*() {
 *   const endpoint = yield* Effect.service(Endpoint)
 *   if (endpoint.url === "bad") {
 *     return yield* Effect.fail("Unavailable")
 *   }
 *   return endpoint.url
 * })
 *
 * const plan = ExecutionPlan.make(
 *   { provide: Layer.succeed(Endpoint, { url: "bad" }), attempts: 2 },
 *   { provide: Layer.succeed(Endpoint, { url: "good" }) }
 * )
 *
 * const program = Effect.withExecutionPlan(fetchUrl, plan)
 * ```
 *
 * @category fallback
 * @since 3.16.0
 */
export const withExecutionPlan: {
  <Input, Provides, PlanE, PlanR>(
    plan: ExecutionPlan<{ provides: Provides; input: Input; error: PlanE; requirements: PlanR }>
  ): <A, E extends Input, R>(
    effect: Effect<A, E, R>
  ) => Effect<A, E | PlanE, Exclude<R, Provides> | PlanR>
  <A, E extends Input, R, Provides, Input, PlanE, PlanR>(
    effect: Effect<A, E, R>,
    plan: ExecutionPlan<{ provides: Provides; input: Input; error: PlanE; requirements: PlanR }>
  ): Effect<A, E | PlanE, Exclude<R, Provides> | PlanR>
} = internalExecutionPlan.withExecutionPlan

/**
 * Runs an effect and reports any errors to the configured `ErrorReporter`s.
 *
 * **Details**
 *
 * If the `defectsOnly` option is set to `true`, only defects (unrecoverable
 * errors) will be reported, while regular failures will be ignored.
 *
 * @category error handling
 * @since 4.0.0
 */
export const withErrorReporting: <
  Arg extends Effect<any, any, any> | { readonly defectsOnly?: boolean | undefined } | undefined = {
    readonly defectsOnly?: boolean | undefined
  }
>(
  effectOrOptions: Arg,
  options?: { readonly defectsOnly?: boolean | undefined } | undefined
) => [Arg] extends [Effect<infer _A, infer _E, infer _R>] ? Arg : <A, E, R>(self: Effect<A, E, R>) => Effect<A, E, R> =
  internal.withErrorReporting

// -----------------------------------------------------------------------------
// Fallback
// -----------------------------------------------------------------------------

/**
 * Recovers from a typed failure by producing a fallback success value.
 *
 * **Details**
 *
 * If the source effect succeeds, its value is preserved. If it fails in the
 * error channel, `orElseSucceed` evaluates the fallback and succeeds with that
 * value, removing the typed error from the returned effect.
 *
 * Defects and interruptions are not recovered by this operator.
 *
 * **Example** (Replacing failures with a value)
 *
 * ```ts
 * import { Effect } from "effect"
 *
 * const validate = (age: number): Effect.Effect<number, string> => {
 *   if (age < 0) {
 *     return Effect.fail("NegativeAgeError")
 *   } else if (age < 18) {
 *     return Effect.fail("IllegalAgeError")
 *   } else {
 *     return Effect.succeed(age)
 *   }
 * }
 *
 * const program = Effect.orElseSucceed(validate(-1), () => 18)
 *
 * console.log(Effect.runSyncExit(program))
 * // Output:
 * // { _id: 'Exit', _tag: 'Success', value: 18 }
 * ```
 *
 * @category fallback
 * @since 2.0.0
 */
export const orElseSucceed: {
  <A2>(
    evaluate: LazyArg<A2>
  ): <A, E, R>(self: Effect<A, E, R>) => Effect<A2 | A, never, R>
  <A, E, R, A2>(
    self: Effect<A, E, R>,
    evaluate: LazyArg<A2>
  ): Effect<A | A2, never, R>
} = internal.orElseSucceed

/**
 * Runs a sequence of effects and returns the result of the first successful
 * one.
 *
 * **When to use**
 *
 * Use when you have prioritized fallback strategies, such as
 * attempting multiple APIs, reading configuration from several sources, or
 * trying alternative resource locations in order.
 *
 * **Details**
 *
 * This function executes the provided effects in sequence, stopping at the
 * first success. If an effect succeeds, its result is returned immediately and
 * no further effects in the sequence are executed.
 *
 * If all effects fail, the returned effect fails with the error from the last
 * effect. If the collection is empty, the returned effect defects with an
 * `Error` whose message is `"Received an empty collection of effects"`.
 *
 * **Example** (Trying alternatives until one succeeds)
 *
 * ```ts
 * import { Effect } from "effect"
 *
 * const primary = Effect.fail("primary unavailable")
 * const secondary = Effect.succeed("secondary result")
 * const tertiary = Effect.sync(() => {
 *   throw new Error("not evaluated")
 * })
 *
 * const program = Effect.firstSuccessOf([
 *   primary,
 *   secondary,
 *   tertiary
 * ])
 *
 * console.log(Effect.runSync(program))
 * // Output: "secondary result"
 * ```
 *
 * @category fallback
 * @since 2.0.0
 */
export const firstSuccessOf: <Eff extends Effect<any, any, any>>(
  effects: Iterable<Eff>
) => Effect<Success<Eff>, Error<Eff>, Services<Eff>> = internal.firstSuccessOf

// -----------------------------------------------------------------------------
// Delays & timeouts
// -----------------------------------------------------------------------------

/**
 * Adds a time limit to an effect, triggering a timeout if the effect exceeds
 * the duration.
 *
 * **When to use**
 *
 * Use when exceeding the time limit should be represented as a typed
 * failure. Use `timeoutOption` when a timeout should become `Option.none`, and
 * `timeoutOrElse` when you want to run a fallback effect.
 *
 * **Details**
 *
 * The `timeout` function allows you to specify a time limit for an
 * effect's execution. If the effect does not complete within the given time, a
 * `TimeoutException` is raised. This can be useful for controlling how long
 * your program waits for a task to finish, ensuring that it doesn't hang
 * indefinitely if the task takes too long.
 *
 * **Gotchas**
 *
 * If the timeout wins, the source effect is interrupted.
 *
 * **Example** (Failing when work takes too long)
 *
 * ```ts
 * import { Effect } from "effect"
 *
 * const task = Effect.gen(function*() {
 *   console.log("Start processing...")
 *   yield* Effect.sleep("2 seconds") // Simulates a delay in processing
 *   console.log("Processing complete.")
 *   return "Result"
 * })
 *
 * // Output will show a TimeoutException as the task takes longer
 * // than the specified timeout duration
 * const timedEffect = task.pipe(Effect.timeout("1 second"))
 *
 * Effect.runPromiseExit(timedEffect).then(console.log)
 * // Output:
 * // Start processing...
 * // {
 * //   _id: 'Exit',
 * //   _tag: 'Failure',
 * //   cause: {
 * //     _id: 'Cause',
 * //     _tag: 'Fail',
 * //     failure: { _tag: 'TimeoutException' }
 * //   }
 * // }
 * ```
 *
 * @see {@link timeoutOption} for returning `Option.none` on timeout.
 * @see {@link timeoutOrElse} for a version that allows specifying both success and timeout handlers.
 *
 * @category delays & timeouts
 * @since 2.0.0
 */
export const timeout: {
  (
    duration: Duration.Input
  ): <A, E, R>(self: Effect<A, E, R>) => Effect<A, E | Cause.TimeoutError, R>
  <A, E, R>(
    self: Effect<A, E, R>,
    duration: Duration.Input
  ): Effect<A, E | Cause.TimeoutError, R>
} = internal.timeout

/**
 * Runs an effect with a time limit and represents only the timeout case as
 * `Option.none`.
 *
 * **When to use**
 *
 * Use when a timeout should be handled as absence. Use
 * `timeout` when a timeout should fail the effect, and `timeoutOrElse` when
 * you want to run a fallback effect.
 *
 * **Details**
 *
 * If the source effect succeeds before the timeout, the returned effect
 * succeeds with `Option.some(value)`. If the timeout wins, the source effect is
 * interrupted and the returned effect succeeds with `Option.none`. If the
 * source effect fails before the timeout, that failure is preserved.
 *
 * **Example** (Returning None on timeout)
 *
 * ```ts
 * import { Effect } from "effect"
 *
 * const task = Effect.gen(function*() {
 *   console.log("Start processing...")
 *   yield* Effect.sleep("2 seconds") // Simulates a delay in processing
 *   console.log("Processing complete.")
 *   return "Result"
 * })
 *
 * const timedOutEffect = Effect.all([
 *   task.pipe(Effect.timeoutOption("3 seconds")),
 *   task.pipe(Effect.timeoutOption("1 second"))
 * ])
 *
 * Effect.runPromise(timedOutEffect).then(console.log)
 * // Output:
 * // Start processing...
 * // Processing complete.
 * // Start processing...
 * // [
 * //   { _id: 'Option', _tag: 'Some', value: 'Result' },
 * //   { _id: 'Option', _tag: 'None' }
 * // ]
 * ```
 *
 * @see {@link timeout} for a version that raises a `TimeoutException`.
 * @see {@link timeoutOrElse} for a version that allows specifying both success and timeout handlers.
 *
 * @category delays & timeouts
 * @since 3.1.0
 */
export const timeoutOption: {
  (
    duration: Duration.Input
  ): <A, E, R>(self: Effect<A, E, R>) => Effect<Option<A>, E, R>
  <A, E, R>(
    self: Effect<A, E, R>,
    duration: Duration.Input
  ): Effect<Option<A>, E, R>
} = internal.timeoutOption

/**
 * Applies a timeout to an effect, with a fallback effect executed if the timeout is reached.
 *
 * **When to use**
 *
 * Use when a timeout should switch to a fallback effect. Use
 * `timeout` when a timeout should fail the effect, and `timeoutOption` when a
 * timeout should become `Option.none`.
 *
 * **Details**
 *
 * The fallback effect is created lazily by `orElse` and may introduce its own
 * success, failure, and requirement types.
 *
 * **Gotchas**
 *
 * If the timeout wins, the source effect is interrupted before the fallback is
 * run.
 *
 * **Example** (Falling back on timeout)
 *
 * ```ts
 * import { Console, Effect } from "effect"
 *
 * const slowQuery = Effect.gen(function*() {
 *   yield* Console.log("Starting database query...")
 *   yield* Effect.sleep("5 seconds")
 *   return "Database result"
 * })
 *
 * // Use cached data as fallback when timeout is reached
 * const program = Effect.timeoutOrElse(slowQuery, {
 *   duration: "2 seconds",
 *   orElse: () =>
 *     Effect.gen(function*() {
 *       yield* Console.log("Query timed out, using cached data")
 *       return "Cached result"
 *     })
 * })
 *
 * Effect.runPromise(program).then(console.log)
 * // Output:
 * // Starting database query...
 * // Query timed out, using cached data
 * // Cached result
 * ```
 *
 * @see {@link timeout} for failing with a `TimeoutException`.
 * @see {@link timeoutOption} for returning `Option.none` on timeout.
 *
 * @category delays & timeouts
 * @since 4.0.0
 */
export const timeoutOrElse: {
  <A2, E2, R2>(options: {
    readonly duration: Duration.Input
    readonly orElse: LazyArg<Effect<A2, E2, R2>>
  }): <A, E, R>(self: Effect<A, E, R>) => Effect<A | A2, E | E2, R | R2>
  <A, E, R, A2, E2, R2>(
    self: Effect<A, E, R>,
    options: {
      readonly duration: Duration.Input
      readonly orElse: LazyArg<Effect<A2, E2, R2>>
    }
  ): Effect<A | A2, E | E2, R | R2>
} = internal.timeoutOrElse

/**
 * Returns an effect that is delayed from this effect by the specified
 * `Duration`.
 *
 * **Example** (Delaying an effect)
 *
 * ```ts
 * import { Console, Effect } from "effect"
 *
 * const program = Effect.delay(
 *   Console.log("Delayed message"),
 *   "1 second"
 * )
 *
 * Effect.runFork(program)
 * // Waits 1 second, then prints: "Delayed message"
 * ```
 *
 * @category delays & timeouts
 * @since 2.0.0
 */
export const delay: {
  (
    duration: Duration.Input
  ): <A, E, R>(self: Effect<A, E, R>) => Effect<A, E, R>
  <A, E, R>(
    self: Effect<A, E, R>,
    duration: Duration.Input
  ): Effect<A, E, R>
} = internal.delay

/**
 * Returns an effect that suspends the current fiber for the specified duration
 * without blocking a JavaScript thread.
 *
 * **Example** (Pausing without blocking)
 *
 * ```ts
 * import { Console, Effect } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   yield* Console.log("Start")
 *   yield* Effect.sleep("2 seconds")
 *   yield* Console.log("End")
 * })
 *
 * Effect.runFork(program)
 * // Output: "Start" (immediately)
 * // Output: "End" (after 2 seconds)
 * ```
 *
 * @category delays & timeouts
 * @since 2.0.0
 */
export const sleep: (duration: Duration.Input) => Effect<void> = internal.sleep

/**
 * Returns the runtime duration of an effect together with its result.
 *
 * **Details**
 *
 * The original success, failure, or interruption is preserved; only the success
 * value is paired with the duration.
 *
 * **Example** (Measuring execution time)
 *
 * ```ts
 * import { Console, Duration, Effect } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const [duration, value] = yield* Effect.timed(Effect.succeed("ok"))
 *   yield* Console.log(`took ${Duration.toMillis(duration)}ms: ${value}`)
 * })
 * ```
 *
 * @category delays & timeouts
 * @since 2.0.0
 */
export const timed: <A, E, R>(self: Effect<A, E, R>) => Effect<[duration: Duration.Duration, result: A], E, R> =
  internal.timed

// -----------------------------------------------------------------------------
// Racing
// -----------------------------------------------------------------------------

/**
 * Runs multiple effects concurrently and returns the first successful result.
 *
 * **When to use**
 *
 * Use when early failures should be ignored until a success occurs
 * or all effects fail.
 *
 * **Details**
 *
 * Early failures do not finish the race; `raceAll` keeps waiting until one
 * effect succeeds or every effect has failed. When one effect succeeds, the
 * remaining effects are interrupted. If every effect fails, the returned effect
 * fails with a cause containing the collected failure reasons.
 *
 * **Example** (Racing many effects)
 *
 * ```ts
 * import { Duration, Effect } from "effect"
 *
 * // Multiple effects with different delays
 * const effect1 = Effect.delay(Effect.succeed("Fast"), Duration.millis(100))
 * const effect2 = Effect.delay(Effect.succeed("Slow"), Duration.millis(500))
 * const effect3 = Effect.delay(Effect.succeed("Very Slow"), Duration.millis(1000))
 *
 * // Race all effects - the first to succeed wins
 * const raced = Effect.raceAll([effect1, effect2, effect3])
 *
 * // Result: "Fast" (after ~100ms)
 * ```
 *
 * @see {@link race} for a version that handles only two effects.
 * @category racing
 * @since 2.0.0
 */
export const raceAll: <Eff extends Effect<any, any, any>>(
  all: Iterable<Eff>,
  options?: {
    readonly onWinner?: (options: {
      readonly fiber: Fiber<any, any>
      readonly index: number
      readonly parentFiber: Fiber<any, any>
    }) => void
  }
) => Effect<Success<Eff>, Error<Eff>, Services<Eff>> = internal.raceAll

/**
 * Runs multiple effects concurrently and completes with the first effect to
 * finish, whether it succeeds or fails.
 *
 * **Details**
 *
 * After the first effect completes, all remaining effects are interrupted. Use
 * `raceAll` when early failures should be ignored until a success occurs or
 * all effects fail.
 *
 * **Example** (Taking the first settled result)
 *
 * ```ts
 * import { Duration, Effect } from "effect"
 *
 * // Multiple effects with different delays and potential failures
 * const effect1 = Effect.delay(Effect.succeed("First"), Duration.millis(200))
 * const effect2 = Effect.delay(Effect.fail("Second failed"), Duration.millis(100))
 * const effect3 = Effect.delay(Effect.succeed("Third"), Duration.millis(300))
 *
 * // Race all effects - the first to succeed wins
 * const raced = Effect.raceAllFirst([effect1, effect2, effect3])
 *
 * // Result: "First" (after ~200ms, even though effect2 completes first but fails)
 * ```
 *
 * @category racing
 * @since 4.0.0
 */
export const raceAllFirst: <Eff extends Effect<any, any, any>>(
  all: Iterable<Eff>,
  options?: {
    readonly onWinner?: (options: {
      readonly fiber: Fiber<any, any>
      readonly index: number
      readonly parentFiber: Fiber<any, any>
    }) => void
  }
) => Effect<Success<Eff>, Error<Eff>, Services<Eff>> = internal.raceAllFirst

/**
 * Races two effects and returns the first successful result.
 *
 * **Details**
 *
 * If one effect succeeds, the other is interrupted and `onWinner` can observe the
 * winning fiber. If both fail, the race fails.
 *
 * **Example** (Racing two effects)
 *
 * ```ts
 * import { Console, Duration, Effect } from "effect"
 *
 * const fastFail = Effect.delay(Effect.fail("fast-fail"), Duration.millis(10))
 * const slowSuccess = Effect.delay(Effect.succeed("slow-success"), Duration.millis(50))
 *
 * const program = Effect.gen(function*() {
 *   const result = yield* Effect.race(fastFail, slowSuccess)
 *   yield* Console.log(`winner: ${result}`)
 * })
 *
 * Effect.runPromise(program)
 * // Output: winner: slow-success
 * ```
 *
 * @category racing
 * @since 2.0.0
 */
export const race: {
  <A2, E2, R2>(
    that: Effect<A2, E2, R2>,
    options?: {
      readonly onWinner?: (
        options: { readonly fiber: Fiber<any, any>; readonly index: number; readonly parentFiber: Fiber<any, any> }
      ) => void
    }
  ): <A, E, R>(self: Effect<A, E, R>) => Effect<A | A2, E | E2, R | R2>
  <A, E, R, A2, E2, R2>(
    self: Effect<A, E, R>,
    that: Effect<A2, E2, R2>,
    options?: {
      readonly onWinner?: (
        options: { readonly fiber: Fiber<any, any>; readonly index: number; readonly parentFiber: Fiber<any, any> }
      ) => void
    }
  ): Effect<A | A2, E | E2, R | R2>
} = internal.race

/**
 * Races two effects and returns the result of the first one to complete, whether
 * it succeeds or fails.
 *
 * **Details**
 *
 * The losing effect is interrupted, and `onWinner` can observe the winning fiber.
 *
 * **Example** (Observing the winning fiber)
 *
 * ```ts
 * import { Console, Duration, Effect } from "effect"
 *
 * const fastFail = Effect.delay(Effect.fail("fast-fail"), Duration.millis(10))
 * const slowSuccess = Effect.delay(Effect.succeed("slow-success"), Duration.millis(50))
 *
 * const program = Effect.gen(function*() {
 *   const message = yield* Effect.match(Effect.raceFirst(fastFail, slowSuccess), {
 *     onFailure: (error) => `failed: ${error}`,
 *     onSuccess: (value) => `succeeded: ${value}`
 *   })
 *   yield* Console.log(message)
 * })
 *
 * Effect.runPromise(program)
 * // Output: failed: fast-fail
 * ```
 *
 * @category racing
 * @since 2.0.0
 */
export const raceFirst: {
  <A2, E2, R2>(
    that: Effect<A2, E2, R2>,
    options?: {
      readonly onWinner?: (
        options: { readonly fiber: Fiber<any, any>; readonly index: number; readonly parentFiber: Fiber<any, any> }
      ) => void
    }
  ): <A, E, R>(self: Effect<A, E, R>) => Effect<A | A2, E | E2, R | R2>
  <A, E, R, A2, E2, R2>(
    self: Effect<A, E, R>,
    that: Effect<A2, E2, R2>,
    options?: {
      readonly onWinner?: (
        options: { readonly fiber: Fiber<any, any>; readonly index: number; readonly parentFiber: Fiber<any, any> }
      ) => void
    }
  ): Effect<A | A2, E | E2, R | R2>
} = internal.raceFirst

// -----------------------------------------------------------------------------
// Filtering
// -----------------------------------------------------------------------------

/**
 * Filters elements of an iterable using a predicate, refinement, or effectful
 * predicate.
 *
 * **Example** (Filtering success values)
 *
 * ```ts
 * import { Effect } from "effect"
 *
 * // Sync predicate
 * const evens = Effect.filter([1, 2, 3, 4], (n) => n % 2 === 0)
 *
 * // Effectful predicate
 * const checked = Effect.filter([1, 2, 3], (n) => Effect.succeed(n > 1))
 *
 * // Use Effect.filterMapEffect for effectful Filter.Filter callbacks
 * ```
 *
 * @category filtering
 * @since 2.0.0
 */
export const filter: {
  <A, B extends A>(
    refinement: Predicate.Refinement<NoInfer<A>, B>
  ): (elements: Iterable<A>) => Effect<Array<B>>
  <A>(
    predicate: Predicate.Predicate<NoInfer<A>>
  ): (elements: Iterable<A>) => Effect<Array<A>>
  <A, E, R>(
    predicate: (a: NoInfer<A>, i: number) => Effect<boolean, E, R>,
    options?: { readonly concurrency?: Concurrency | undefined }
  ): (iterable: Iterable<A>) => Effect<Array<A>, E, R>
  <A, B extends A>(
    elements: Iterable<A>,
    refinement: Predicate.Refinement<A, B>
  ): Effect<Array<B>>
  <A>(
    elements: Iterable<A>,
    predicate: Predicate.Predicate<A>
  ): Effect<Array<A>>
  <A, E, R>(
    iterable: Iterable<A>,
    predicate: (a: NoInfer<A>, i: number) => Effect<boolean, E, R>,
    options?: { readonly concurrency?: Concurrency | undefined }
  ): Effect<Array<A>, E, R>
} = internal.filter

/**
 * Filters and maps elements of an iterable with a `Filter`.
 *
 * **When to use**
 *
 * Use to keep only iterable elements accepted by a `Filter` and collect each
 * filter success value.
 *
 * **Details**
 *
 * `Result.succeed` values are collected in the returned array, and
 * `Result.fail` values are skipped.
 *
 * @see {@link filter} for keeping original elements with a boolean predicate, refinement, or effectful predicate
 * @see {@link filterMapEffect} for using an effectful `Filter`
 *
 * @category filtering
 * @since 2.0.0
 */
export const filterMap: {
  <A, B, X>(
    filter: Filter.Filter<NoInfer<A>, B, X>
  ): (elements: Iterable<A>) => Effect<Array<B>>
  <A, B, X>(
    elements: Iterable<A>,
    filter: Filter.Filter<NoInfer<A>, B, X>
  ): Effect<Array<B>>
} = internal.filterMap

/**
 * Filters and maps elements of an iterable effectfully with a `FilterEffect`.
 *
 * **When to use**
 *
 * Use when filtering each iterable element requires effects and accepted
 * elements should be transformed into successful output values.
 *
 * **Details**
 *
 * `Result.succeed` values are collected in the returned array, and
 * `Result.fail` values are skipped.
 *
 * **Gotchas**
 *
 * With concurrent execution, successful values are collected in completion
 * order, not input order.
 *
 * @see {@link filterMap} for using a synchronous `Filter`
 * @see {@link filter} for keeping original elements with a predicate
 *
 * @category filtering
 * @since 4.0.0
 */
export const filterMapEffect: {
  <A, B, X, E, R>(
    filter: Filter.FilterEffect<NoInfer<A>, B, X, E, R>,
    options?: { readonly concurrency?: Concurrency | undefined }
  ): (elements: Iterable<A>) => Effect<Array<B>, E, R>
  <A, B, X, E, R>(
    elements: Iterable<A>,
    filter: Filter.FilterEffect<NoInfer<A>, B, X, E, R>,
    options?: { readonly concurrency?: Concurrency | undefined }
  ): Effect<Array<B>, E, R>
} = internal.filterMapEffect

/**
 * Filters an effect, providing an alternative effect if the predicate fails.
 *
 * **Details**
 *
 * This function applies a predicate to the result of an effect. If the
 * predicate evaluates to `false`, it executes the `orElse` effect instead. The
 * `orElse` effect can produce an alternative value or perform additional
 * computations.
 *
 * **Example** (Filtering with a fallback effect)
 *
 * ```ts
 * import { Effect } from "effect"
 *
 * // An effect that produces a number
 * const program = Effect.succeed(5)
 *
 * // Filter for even numbers, provide alternative for odd numbers
 * const filtered = Effect.filterOrElse(
 *   program,
 *   (n) => n % 2 === 0,
 *   (n) => Effect.succeed(`Number ${n} is odd`)
 * )
 *
 * // Result: "Number 5 is odd" (since 5 is not even)
 * ```
 *
 * @category filtering
 * @since 2.0.0
 */
export const filterOrElse: {
  <A, C, E2, R2, B extends A>(
    refinement: Predicate.Refinement<NoInfer<A>, B>,
    orElse: (a: EqualsWith<A, B, NoInfer<A>, Exclude<NoInfer<A>, B>>) => Effect<C, E2, R2>
  ): <E, R>(self: Effect<A, E, R>) => Effect<B | C, E2 | E, R2 | R>
  <A, C, E2, R2>(
    predicate: Predicate.Predicate<NoInfer<A>>,
    orElse: (a: NoInfer<A>) => Effect<C, E2, R2>
  ): <E, R>(self: Effect<A, E, R>) => Effect<A | C, E2 | E, R2 | R>
  <A, E, R, C, E2, R2, B extends A>(
    self: Effect<A, E, R>,
    refinement: Predicate.Refinement<A, B>,
    orElse: (a: EqualsWith<A, B, A, Exclude<A, B>>) => Effect<C, E2, R2>
  ): Effect<B | C, E | E2, R | R2>
  <A, E, R, C, E2, R2>(
    self: Effect<A, E, R>,
    predicate: Predicate.Predicate<NoInfer<A>>,
    orElse: (a: NoInfer<A>) => Effect<C, E2, R2>
  ): Effect<A | C, E | E2, R | R2>
} = internal.filterOrElse

/**
 * Filters an effect with a `Filter`, providing an alternative effect on failure.
 *
 * **When to use**
 *
 * Use when a successful effect value should be accepted and transformed by a
 * `Filter`, while rejected values should continue with an alternative effect
 * built from the filter failure.
 *
 * **Details**
 *
 * `Result.succeed` becomes the returned success value, and `Result.fail` is
 * passed to `orElse`.
 *
 * @see {@link filterOrElse} for using a predicate and fallback effect
 * @see {@link filterMapOrFail} for failing the effect when the filter fails
 *
 * @category filtering
 * @since 4.0.0
 */
export const filterMapOrElse: {
  <A, B, X, C, E2, R2>(
    filter: Filter.Filter<NoInfer<A>, B, X>,
    orElse: (x: X) => Effect<C, E2, R2>
  ): <E, R>(self: Effect<A, E, R>) => Effect<B | C, E2 | E, R2 | R>
  <A, E, R, B, X, C, E2, R2>(
    self: Effect<A, E, R>,
    filter: Filter.Filter<NoInfer<A>, B, X>,
    orElse: (x: X) => Effect<C, E2, R2>
  ): Effect<B | C, E | E2, R | R2>
} = internal.filterMapOrElse

/**
 * Filters an effect, failing with a custom error if the predicate fails.
 *
 * **Details**
 *
 * This function applies a predicate to the result of an effect. If the
 * predicate evaluates to `false`, the effect fails with either a custom
 * error (if `orFailWith` is provided) or a `NoSuchElementError`.
 *
 * **Example** (Filtering with a custom failure)
 *
 * ```ts
 * import { Effect } from "effect"
 *
 * // An effect that produces a number
 * const program = Effect.succeed(5)
 *
 * // Filter for even numbers, fail for odd numbers
 * const filtered = Effect.filterOrFail(
 *   program,
 *   (n) => n % 2 === 0,
 *   (n) => `Expected even number, got ${n}`
 * )
 *
 * // Result: Effect.fail("Expected even number, got 5")
 * ```
 *
 * @category filtering
 * @since 2.0.0
 */
export const filterOrFail: {
  <A, E2, B extends A>(
    refinement: Predicate.Refinement<NoInfer<A>, B>,
    orFailWith: (a: NoInfer<A>) => E2
  ): <E, R>(self: Effect<A, E, R>) => Effect<B, E2 | E, R>
  <A, E2>(
    predicate: Predicate.Predicate<NoInfer<A>>,
    orFailWith: (a: NoInfer<A>) => E2
  ): <E, R>(self: Effect<A, E, R>) => Effect<A, E2 | E, R>
  <A, B extends A>(
    refinement: Predicate.Refinement<NoInfer<A>, B>
  ): <E, R>(self: Effect<A, E, R>) => Effect<B, Cause.NoSuchElementError | E, R>
  <A>(
    predicate: Predicate.Predicate<NoInfer<A>>
  ): <E, R>(self: Effect<A, E, R>) => Effect<A, Cause.NoSuchElementError | E, R>
  <A, E, R, E2, B extends A>(
    self: Effect<A, E, R>,
    refinement: Predicate.Refinement<NoInfer<A>, B>,
    orFailWith: (a: NoInfer<A>) => E2
  ): Effect<B, E2 | E, R>
  <A, E, R, E2>(
    self: Effect<A, E, R>,
    predicate: Predicate.Predicate<NoInfer<A>>,
    orFailWith: (a: NoInfer<A>) => E2
  ): Effect<A, E2 | E, R>
  <A, E, R, B extends A>(
    self: Effect<A, E, R>,
    refinement: Predicate.Refinement<NoInfer<A>, B>
  ): Effect<B, E | Cause.NoSuchElementError, R>
  <A, E, R>(
    self: Effect<A, E, R>,
    predicate: Predicate.Predicate<NoInfer<A>>
  ): Effect<A, E | Cause.NoSuchElementError, R>
} = internal.filterOrFail

/**
 * Filters and maps an effect with a `Filter`, failing when the filter fails.
 *
 * **When to use**
 *
 * Use when validating and transforming one effect success with a synchronous
 * `Filter`, while rejected values should fail the effect.
 *
 * **Details**
 *
 * `Result.succeed` becomes the returned success value. `Result.fail` is mapped
 * with `orFailWith` when provided, or fails with `NoSuchElementError`.
 *
 * @see {@link filterMapOrElse} for continuing with a fallback effect when the filter fails
 * @see {@link filterOrFail} for validating with a predicate instead of a `Filter`
 * @see {@link filterMap} for filtering and mapping iterable elements
 *
 * @category filtering
 * @since 4.0.0
 */
export const filterMapOrFail: {
  <A, B, X, E2>(
    filter: Filter.Filter<NoInfer<A>, B, X>,
    orFailWith: (x: X) => E2
  ): <E, R>(self: Effect<A, E, R>) => Effect<B, E2 | E, R>
  <A, B, X>(
    filter: Filter.Filter<NoInfer<A>, B, X>
  ): <E, R>(self: Effect<A, E, R>) => Effect<B, Cause.NoSuchElementError | E, R>
  <A, E, R, B, X, E2>(
    self: Effect<A, E, R>,
    filter: Filter.Filter<A, B, X>,
    orFailWith: (x: X) => E2
  ): Effect<B, E2 | E, R>
  <A, E, R, B, X>(
    self: Effect<A, E, R>,
    filter: Filter.Filter<A, B, X>
  ): Effect<B, Cause.NoSuchElementError | E, R>
} = internal.filterMapOrFail

// -----------------------------------------------------------------------------
// Conditional Operators
// -----------------------------------------------------------------------------

/**
 * Runs an effect conditionally based on the result of an effectful boolean
 * condition.
 *
 * **When to use**
 *
 * Use when an effectful check decides whether to run another effect while
 * representing the skipped case explicitly.
 *
 * **Details**
 *
 * The condition effect is evaluated first. If it succeeds with `true`, the
 * source effect is run and its success value is wrapped in `Option.some`. If it
 * succeeds with `false`, the source effect is skipped and the result is
 * `Option.none`. If the condition effect fails, that failure is preserved.
 *
 * **Example** (Conditionally running an effect)
 *
 * ```ts
 * import { Console, Effect } from "effect"
 *
 * const shouldLog = true
 *
 * const program = Effect.when(
 *   Console.log("Condition is true!"),
 *   Effect.succeed(shouldLog)
 * )
 *
 * Effect.runPromise(program).then(console.log)
 * // Output: "Condition is true!"
 * // { _id: 'Option', _tag: 'Some', value: undefined }
 * ```
 *
 * @category conditional operators
 * @since 2.0.0
 */
export const when: {
  <E2 = never, R2 = never>(
    condition: Effect<boolean, E2, R2>
  ): <A, E, R>(self: Effect<A, E, R>) => Effect<Option<A>, E | E2, R | R2>
  <A, E, R, E2 = never, R2 = never>(
    self: Effect<A, E, R>,
    condition: Effect<boolean, E2, R2>
  ): Effect<Option<A>, E | E2, R | R2>
} = internal.when

// -----------------------------------------------------------------------------
// Pattern matching
// -----------------------------------------------------------------------------

/**
 * Handles both success and failure cases of an effect without performing side
 * effects.
 *
 * **When to use**
 *
 * Use when this is useful for structuring your code to respond differently to success or
 * failure without triggering side effects.
 *
 * **Details**
 *
 * `match` lets you define custom handlers for both success and failure
 * scenarios. You provide separate functions to handle each case, allowing you
 * to process the result if the effect succeeds, or handle the error if the
 * effect fails.
 *
 * **Example** (Matching success and failure values)
 *
 * ```ts
 * import { Data, Effect } from "effect"
 *
 * class ExampleError extends Data.TaggedError("ExampleError")<{ readonly message: string }> {}
 *
 * const success: Effect.Effect<number, ExampleError> = Effect.succeed(42)
 *
 * const program1 = Effect.match(success, {
 *   onFailure: (error) => `failure: ${error.message}`,
 *   onSuccess: (value) => `success: ${value}`
 * })
 *
 * // Run and log the result of the successful effect
 * Effect.runPromise(program1).then(console.log)
 * // Output: "success: 42"
 *
 * const failure: Effect.Effect<number, ExampleError> = Effect.fail(
 *   new ExampleError({ message: "Uh oh!" })
 * )
 *
 * const program2 = Effect.match(failure, {
 *   onFailure: (error) => `failure: ${error.message}`,
 *   onSuccess: (value) => `success: ${value}`
 * })
 *
 * // Run and log the result of the failed effect
 * Effect.runPromise(program2).then(console.log)
 * // Output: "failure: Uh oh!"
 * ```
 *
 * @see {@link matchEffect} if you need to perform side effects in the handlers.
 * @category pattern matching
 * @since 2.0.0
 */
export const match: {
  <E, A2, A, A3>(options: {
    readonly onFailure: (error: E) => A2
    readonly onSuccess: (value: A) => A3
  }): <R>(self: Effect<A, E, R>) => Effect<A2 | A3, never, R>
  <A, E, R, A2, A3>(
    self: Effect<A, E, R>,
    options: {
      readonly onFailure: (error: E) => A2
      readonly onSuccess: (value: A) => A3
    }
  ): Effect<A2 | A3, never, R>
} = internal.match

/**
 * Handles both success and failure cases of an effect without performing side
 * effects, with eager evaluation for resolved effects.
 *
 * **When to use**
 *
 * Use when you need to handle both success and failure cases and want
 * optimal performance for resolved effects. This is particularly useful in
 * scenarios where you frequently work with already computed values.
 *
 * **Details**
 *
 * `matchEager` works like `match` but provides better performance for resolved
 * effects (Success or Failure). When the effect is already resolved, it applies
 * the handlers immediately without fiber scheduling. For unresolved effects,
 * it falls back to the regular `match` behavior.
 *
 * **Example** (Pattern matching eagerly when possible)
 *
 * ```ts
 * import { Effect } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const result = yield* Effect.matchEager(Effect.succeed(42), {
 *     onFailure: (error) => `Failed: ${error}`,
 *     onSuccess: (value) => `Success: ${value}`
 *   })
 *   console.log(result) // "Success: 42"
 * })
 * ```
 *
 * @see {@link match} for the non-eager version.
 * @see {@link matchEffect} if you need to perform side effects in the handlers.
 * @category pattern matching
 * @since 4.0.0
 */
export const matchEager: {
  <E, A2, A, A3>(options: {
    readonly onFailure: (error: E) => A2
    readonly onSuccess: (value: A) => A3
  }): <R>(self: Effect<A, E, R>) => Effect<A2 | A3, never, R>
  <A, E, R, A2, A3>(
    self: Effect<A, E, R>,
    options: {
      readonly onFailure: (error: E) => A2
      readonly onSuccess: (value: A) => A3
    }
  ): Effect<A2 | A3, never, R>
} = internal.matchEager

/**
 * Handles failures by matching the cause of failure.
 *
 * **When to use**
 *
 * Use when this is useful for differentiating between different types of errors, such as
 * regular failures, defects, or interruptions. You can provide specific
 * handling logic for each failure type based on the cause.
 *
 * **Details**
 *
 * The `matchCause` function allows you to handle failures with access to the
 * full cause of the failure within a fiber.
 *
 * **Example** (Matching on success or failure causes)
 *
 * ```ts
 * import { Cause, Effect } from "effect"
 *
 * const task = Effect.fail("Something went wrong")
 *
 * const program = Effect.matchCause(task, {
 *   onFailure: (cause) => `Failed: ${Cause.squash(cause)}`,
 *   onSuccess: (value) => `Success: ${value}`
 * })
 *
 * Effect.runPromise(program).then(console.log)
 * // Output: "Failed: Error: Something went wrong"
 * ```
 *
 * @see {@link matchCauseEffect} if you need to perform side effects in the
 * handlers.
 * @see {@link match} if you don't need to handle the cause of the failure.
 * @category pattern matching
 * @since 2.0.0
 */
export const matchCause: {
  <E, A2, A, A3>(options: {
    readonly onFailure: (cause: Cause.Cause<E>) => A2
    readonly onSuccess: (a: A) => A3
  }): <R>(self: Effect<A, E, R>) => Effect<A2 | A3, never, R>
  <A, E, R, A2, A3>(
    self: Effect<A, E, R>,
    options: {
      readonly onFailure: (cause: Cause.Cause<E>) => A2
      readonly onSuccess: (a: A) => A3
    }
  ): Effect<A2 | A3, never, R>
} = internal.matchCause

/**
 * Handles failures by matching the cause of failure with eager evaluation.
 *
 * **When to use**
 *
 * Use when this is useful when you have effects that are likely to be already resolved
 * and you want to avoid the overhead of the effect pipeline. For pending effects,
 * it automatically falls back to the regular `matchCause` behavior.
 *
 * **Details**
 *
 * `matchCauseEager` works like `matchCause` but provides better performance for resolved
 * effects by immediately applying the matching function instead of deferring it
 * through the effect pipeline.
 *
 * **Example** (Eagerly matching already completed effects)
 *
 * ```ts
 * import { Effect } from "effect"
 *
 * const handleResult = Effect.matchCauseEager(Effect.succeed(42), {
 *   onSuccess: (value) => `Success: ${value}`,
 *   onFailure: (cause) => `Failed: ${cause}`
 * })
 * ```
 *
 * @category pattern matching
 * @since 4.0.0
 */
export const matchCauseEager: {
  <E, A2, A, A3>(options: {
    readonly onFailure: (cause: Cause.Cause<E>) => A2
    readonly onSuccess: (value: A) => A3
  }): <R>(self: Effect<A, E, R>) => Effect<A2 | A3, never, R>
  <A, E, R, A2, A3>(
    self: Effect<A, E, R>,
    options: {
      readonly onFailure: (cause: Cause.Cause<E>) => A2
      readonly onSuccess: (value: A) => A3
    }
  ): Effect<A2 | A3, never, R>
} = internal.matchCauseEager

/**
 * Handles success or failure eagerly with effectful handlers when the effect is already resolved.
 *
 * **When to use**
 *
 * Use when success and cause-aware failure handlers return effects and the
 * input may already be resolved, so the selected handler can run immediately
 * while unresolved inputs keep normal effectful matching behavior.
 *
 * **Details**
 *
 * If the effect is an `Exit`, the matching handler runs immediately; otherwise it behaves like
 * {@link matchCauseEffect}.
 *
 * @see {@link matchCauseEffect} for the non-eager effectful variant
 * @see {@link matchCauseEager} for eager cause matching with pure handlers
 * @see {@link matchEffect} for effectful matching on typed failures instead of full causes
 *
 * @category pattern matching
 * @since 4.0.0
 */
export const matchCauseEffectEager: {
  <E, A2, E2, R2, A, A3, E3, R3>(
    options: {
      readonly onFailure: (cause: Cause.Cause<E>) => Effect<A2, E2, R2>
      readonly onSuccess: (a: A) => Effect<A3, E3, R3>
    }
  ): <R>(self: Effect<A, E, R>) => Effect<A2 | A3, E2 | E3, R2 | R3 | R>
  <A, E, R, A2, E2, R2, A3, E3, R3>(
    self: Effect<A, E, R>,
    options: {
      readonly onFailure: (cause: Cause.Cause<E>) => Effect<A2, E2, R2>
      readonly onSuccess: (a: A) => Effect<A3, E3, R3>
    }
  ): Effect<A2 | A3, E2 | E3, R2 | R3 | R>
} = internal.matchCauseEffectEager

/**
 * Handles failures with access to the cause and allows performing side effects.
 *
 * **When to use**
 *
 * Use when both success and failure handling must return effects and the
 * failure branch needs the full `Cause`.
 *
 * **Details**
 *
 * The `matchCauseEffect` function works similarly to {@link matchCause}, but it
 * also allows you to perform additional side effects based on the failure
 * cause. This function provides access to the complete cause of the failure,
 * making it possible to differentiate between various failure types, and allows
 * you to respond accordingly while performing side effects (like logging or
 * other operations).
 *
 * **Example** (Effectfully matching on causes)
 *
 * ```ts
 * import { Cause, Console, Data, Effect, Result } from "effect"
 *
 * class TaskError extends Data.TaggedError("TaskError")<{ readonly message: string }> {}
 *
 * const task = Effect.fail(new TaskError({ message: "Task failed" }))
 *
 * const program = Effect.matchCauseEffect(task, {
 *   onFailure: (cause) =>
 *     Effect.gen(function*() {
 *       if (Cause.hasFails(cause)) {
 *         const error = Cause.findError(cause)
 *         if (Result.isSuccess(error)) {
 *           yield* Console.log(`Handling error: ${error.success.message}`)
 *         }
 *         return "recovered from error"
 *       } else {
 *         yield* Console.log("Handling interruption or defect")
 *         return "recovered from interruption/defect"
 *       }
 *     }),
 *   onSuccess: (value) =>
 *     Effect.gen(function*() {
 *       yield* Console.log(`Success: ${value}`)
 *       return `processed ${value}`
 *     })
 * })
 *
 * Effect.runPromise(program).then(console.log)
 * // Output:
 * // Handling error: Task failed
 * // recovered from error
 * ```
 *
 * @see {@link matchCause} if you don't need side effects and only want to handle the result or failure.
 * @see {@link matchEffect} if you don't need to handle the cause of the failure.
 *
 * @category pattern matching
 * @since 2.0.0
 */
export const matchCauseEffect: {
  <E, A2, E2, R2, A, A3, E3, R3>(options: {
    readonly onFailure: (cause: Cause.Cause<E>) => Effect<A2, E2, R2>
    readonly onSuccess: (a: A) => Effect<A3, E3, R3>
  }): <R>(self: Effect<A, E, R>) => Effect<A2 | A3, E2 | E3, R2 | R3 | R>
  <A, E, R, A2, E2, R2, A3, E3, R3>(
    self: Effect<A, E, R>,
    options: {
      readonly onFailure: (cause: Cause.Cause<E>) => Effect<A2, E2, R2>
      readonly onSuccess: (a: A) => Effect<A3, E3, R3>
    }
  ): Effect<A2 | A3, E2 | E3, R2 | R3 | R>
} = internal.matchCauseEffect

/**
 * Handles both success and failure by running effectful handlers.
 *
 * **When to use**
 *
 * Use when the failure or success branch must run additional effects.
 *
 * **Details**
 *
 * Use `matchEffect` when either branch needs to return an `Effect`, such as
 * performing logging, recovery, notification, or other effectful work. The
 * returned effect succeeds or fails according to the handler that is run.
 *
 * **Example** (Matching success and failure with effectful handlers)
 *
 * ```ts
 * import { Data, Effect } from "effect"
 *
 * class ExampleError extends Data.TaggedError("ExampleError")<{ readonly message: string }> {}
 *
 * const success: Effect.Effect<number, ExampleError> = Effect.succeed(42)
 * const failure: Effect.Effect<number, ExampleError> = Effect.fail(
 *   new ExampleError({ message: "Uh oh!" })
 * )
 *
 * const program1 = Effect.matchEffect(success, {
 *   onFailure: (error) =>
 *     Effect.succeed(`failure: ${error.message}`).pipe(
 *       Effect.tap(Effect.log)
 *     ),
 *   onSuccess: (value) =>
 *     Effect.succeed(`success: ${value}`).pipe(Effect.tap(Effect.log))
 * })
 *
 * console.log(Effect.runSync(program1))
 * // Output:
 * // timestamp=... level=INFO fiber=#0 message="success: 42"
 * // success: 42
 *
 * const program2 = Effect.matchEffect(failure, {
 *   onFailure: (error) =>
 *     Effect.succeed(`failure: ${error.message}`).pipe(
 *       Effect.tap(Effect.log)
 *     ),
 *   onSuccess: (value) =>
 *     Effect.succeed(`success: ${value}`).pipe(Effect.tap(Effect.log))
 * })
 *
 * console.log(Effect.runSync(program2))
 * // Output:
 * // timestamp=... level=INFO fiber=#1 message="failure: Uh oh!"
 * // failure: Uh oh!
 * ```
 *
 * @see {@link match} if you don't need side effects and only want to handle the
 * result or failure.
 * @category pattern matching
 * @since 2.0.0
 */
export const matchEffect: {
  <E, A2, E2, R2, A, A3, E3, R3>(options: {
    readonly onFailure: (e: E) => Effect<A2, E2, R2>
    readonly onSuccess: (a: A) => Effect<A3, E3, R3>
  }): <R>(self: Effect<A, E, R>) => Effect<A2 | A3, E2 | E3, R2 | R3 | R>
  <A, E, R, A2, E2, R2, A3, E3, R3>(
    self: Effect<A, E, R>,
    options: {
      readonly onFailure: (e: E) => Effect<A2, E2, R2>
      readonly onSuccess: (a: A) => Effect<A3, E3, R3>
    }
  ): Effect<A2 | A3, E2 | E3, R2 | R3 | R>
} = internal.matchEffect

// -----------------------------------------------------------------------------
// Condition checking
// -----------------------------------------------------------------------------

/**
 * Determines whether an effect fails.
 *
 * **Details**
 *
 * Defects are not converted; if the effect dies, the resulting effect dies too.
 *
 * **Example** (Checking whether an effect fails)
 *
 * ```ts
 * import { Console, Effect } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const failed = yield* Effect.isFailure(Effect.fail("Uh oh!"))
 *   yield* Console.log(failed)
 * })
 *
 * Effect.runPromise(program)
 * // Output: true
 * ```
 *
 * @category condition checking
 * @since 2.0.0
 */
export const isFailure: <A, E, R>(self: Effect<A, E, R>) => Effect<boolean, never, R> = internal.isFailure

/**
 * Returns whether an effect completes successfully.
 *
 * **Details**
 *
 * Returns `false` for failures in the error channel, but defects still fail the
 * effect.
 *
 * **Example** (Checking whether an effect succeeds)
 *
 * ```ts
 * import { Console, Effect } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const ok = yield* Effect.isSuccess(Effect.succeed("done"))
 *   const failed = yield* Effect.isSuccess(Effect.fail("Uh oh"))
 *   yield* Console.log(`ok: ${ok}`)
 *   yield* Console.log(`failed: ${failed}`)
 * })
 *
 * Effect.runPromise(program)
 * // Output:
 * // ok: true
 * // failed: false
 * ```
 *
 * @category condition checking
 * @since 2.0.0
 */
export const isSuccess: <A, E, R>(self: Effect<A, E, R>) => Effect<boolean, never, R> = internal.isSuccess

// -----------------------------------------------------------------------------
// Environment
// -----------------------------------------------------------------------------

/**
 * Returns the complete context.
 *
 * **When to use**
 *
 * Use to read the complete `Context` available to the current effect.
 *
 * **Details**
 *
 * This function allows you to access all services that are currently available
 * in the effect's environment. This can be useful for debugging, introspection,
 * or when you need to pass the entire context to another function.
 *
 * **Example** (Reading the full context)
 *
 * ```ts
 * import { Console, Context, Effect, Option } from "effect"
 *
 * const Logger = Context.Service<{
 *   log: (msg: string) => void
 * }>("Logger")
 * const Database = Context.Service<{
 *   query: (sql: string) => string
 * }>("Database")
 *
 * const program = Effect.gen(function*() {
 *   const allServices = yield* Effect.context()
 *
 *   // Check if specific services are available
 *   const loggerOption = Context.getOption(allServices, Logger)
 *   const databaseOption = Context.getOption(allServices, Database)
 *
 *   yield* Console.log(`Logger available: ${Option.isSome(loggerOption)}`)
 *   yield* Console.log(`Database available: ${Option.isSome(databaseOption)}`)
 * })
 *
 * const context = Context.make(Logger, { log: console.log })
 *   .pipe(Context.add(Database, { query: () => "result" }))
 *
 * const provided = Effect.provideContext(program, context)
 * ```
 *
 * @see {@link contextWith} for deriving an effect from the complete context
 * @see {@link service} for reading one service from the context
 *
 * @category environment
 * @since 2.0.0
 */
export const context: <R = never>() => Effect<Context.Context<R>, never, R> = internal.context

/**
 * Transforms the current context using the provided function.
 *
 * **When to use**
 *
 * Use to derive an effect from the complete `Context`.
 *
 * **Details**
 *
 * This function allows you to access the complete context and perform
 * computations based on all available services. This is useful when you need
 * to conditionally execute logic based on what services are available.
 *
 * **Example** (Deriving values from the context)
 *
 * ```ts
 * import { Console, Context, Effect, Option } from "effect"
 *
 * const Logger = Context.Service<{
 *   log: (msg: string) => void
 * }>("Logger")
 * const Cache = Context.Service<{
 *   get: (key: string) => string | null
 * }>("Cache")
 *
 * const program = Effect.contextWith((services) => {
 *   const cacheOption = Context.getOption(services, Cache)
 *   const hasCache = Option.isSome(cacheOption)
 *
 *   if (hasCache) {
 *     return Effect.gen(function*() {
 *       const cache = yield* Effect.service(Cache)
 *       yield* Console.log("Using cached data")
 *       return cache.get("user:123") || "default"
 *     })
 *   } else {
 *     return Effect.gen(function*() {
 *       yield* Console.log("No cache available, using fallback")
 *       return "fallback data"
 *     })
 *   }
 * })
 *
 * const withCache = Effect.provideService(program, Cache, {
 *   get: () => "cached_value"
 * })
 * ```
 *
 * @see {@link context} for reading the complete context as a value
 * @see {@link service} for reading one service from the context
 *
 * @category environment
 * @since 2.0.0
 */
export const contextWith: <R, A, E, R2>(
  f: (context: Context.Context<R>) => Effect<A, E, R2>
) => Effect<A, E, R | R2> = internal.contextWith

/**
 * Provides dependencies to an effect using layers or a context. Use `options.local`
 * to build the layer every time; by default, layers are shared between provide
 * calls.
 *
 * **Example** (Providing dependencies with a layer)
 *
 * ```ts
 * import { Context, Effect, Layer } from "effect"
 *
 * interface Database {
 *   readonly query: (sql: string) => Effect.Effect<string>
 * }
 *
 * const Database = Context.Service<Database>("Database")
 *
 * const DatabaseLive = Layer.succeed(Database)({
 *   query: Effect.fn("Database.query")((sql: string) => Effect.succeed(`Result for: ${sql}`))
 * })
 *
 * const program = Effect.gen(function*() {
 *   const db = yield* Database
 *   return yield* db.query("SELECT * FROM users")
 * })
 *
 * const provided = Effect.provide(program, DatabaseLive)
 *
 * Effect.runPromise(provided).then(console.log)
 * // Output: "Result for: SELECT * FROM users"
 * ```
 *
 * @category environment
 * @since 2.0.0
 */
export const provide: {
  <const Layers extends [Layer.Any, ...Array<Layer.Any>]>(
    layers: Layers,
    options?: {
      readonly local?: boolean | undefined
    } | undefined
  ): <A, E, R>(
    self: Effect<A, E, R>
  ) => Effect<
    A,
    E | Layer.Error<Layers[number]>,
    Layer.Services<Layers[number]> | Exclude<R, Layer.Success<Layers[number]>>
  >
  <ROut, E2, RIn>(
    layer: Layer.Layer<ROut, E2, RIn>,
    options?: {
      readonly local?: boolean | undefined
    } | undefined
  ): <A, E, R>(
    self: Effect<A, E, R>
  ) => Effect<A, E | E2, RIn | Exclude<R, ROut>>
  <R2>(
    context: Context.Context<R2>
  ): <A, E, R>(self: Effect<A, E, R>) => Effect<A, E, Exclude<R, R2>>
  <A, E, R, const Layers extends [Layer.Any, ...Array<Layer.Any>]>(
    self: Effect<A, E, R>,
    layers: Layers,
    options?: {
      readonly local?: boolean | undefined
    } | undefined
  ): Effect<
    A,
    E | Layer.Error<Layers[number]>,
    Layer.Services<Layers[number]> | Exclude<R, Layer.Success<Layers[number]>>
  >
  <A, E, R, ROut, E2, RIn>(
    self: Effect<A, E, R>,
    layer: Layer.Layer<ROut, E2, RIn>,
    options?: {
      readonly local?: boolean | undefined
    } | undefined
  ): Effect<A, E | E2, RIn | Exclude<R, ROut>>
  <A, E, R, R2>(
    self: Effect<A, E, R>,
    context: Context.Context<R2>
  ): Effect<A, E, Exclude<R, R2>>
} = internalLayer.provide

/**
 * Provides a context to an effect, fulfilling its service requirements.
 *
 * **Details**
 *
 * This function provides multiple services at once by supplying a context
 * that contains all the required services. It removes the provided services
 * from the effect's requirements, making them available to the effect.
 *
 * **Example** (Providing a complete context)
 *
 * ```ts
 * import { Context, Effect } from "effect"
 *
 * // Define service keys
 * const Logger = Context.Service<{
 *   log: (msg: string) => void
 * }>("Logger")
 * const Database = Context.Service<{
 *   query: (sql: string) => string
 * }>("Database")
 *
 * // Create a context with multiple services
 * const context = Context.make(Logger, { log: console.log })
 *   .pipe(Context.add(Database, { query: () => "result" }))
 *
 * // An effect that requires both services
 * const program = Effect.gen(function*() {
 *   const logger = yield* Effect.service(Logger)
 *   const db = yield* Effect.service(Database)
 *   logger.log("Querying database")
 *   return db.query("SELECT * FROM users")
 * })
 *
 * const provided = Effect.provideContext(program, context)
 * ```
 *
 * @category environment
 * @since 4.0.0
 */
export const provideContext: {
  <XR>(
    context: Context.Context<XR>
  ): <A, E, R>(self: Effect<A, E, R>) => Effect<A, E, Exclude<R, XR>>
  <A, E, R, XR>(
    self: Effect<A, E, R>,
    context: Context.Context<XR>
  ): Effect<A, E, Exclude<R, XR>>
} = internal.provideContext

/**
 * Accesses a service from the context.
 *
 * **Example** (Accessing a required service)
 *
 * ```ts
 * import { Context, Effect } from "effect"
 *
 * interface Database {
 *   readonly query: (sql: string) => Effect.Effect<string>
 * }
 *
 * const Database = Context.Service<Database>("Database")
 *
 * const program = Effect.gen(function*() {
 *   const db = yield* Effect.service(Database)
 *   return yield* db.query("SELECT * FROM users")
 * })
 * ```
 *
 * @category context
 * @since 4.0.0
 */
export const service: <I, S>(service: Context.Key<I, S>) => Effect<S, never, I> = internal.service

/**
 * Optionally accesses a service from the environment.
 *
 * **When to use**
 *
 * Use to read an optional dependency from the current context without making
 * that dependency part of the effect's required environment.
 *
 * **Details**
 *
 * This function attempts to access a service from the environment. If the
 * service is available, it returns `Some(service)`. If the service is not
 * available, it returns `None`. Unlike `service`, this function does not
 * require the service to be present in the environment.
 *
 * **Example** (Accessing an optional service)
 *
 * ```ts
 * import { Context, Effect, Option } from "effect"
 *
 * // Define a service key
 * const Logger = Context.Service<{
 *   log: (msg: string) => void
 * }>("Logger")
 *
 * // Use serviceOption to optionally access the logger
 * const program = Effect.gen(function*() {
 *   const maybeLogger = yield* Effect.serviceOption(Logger)
 *
 *   if (Option.isSome(maybeLogger)) {
 *     maybeLogger.value.log("Service is available")
 *   } else {
 *     console.log("Service not available")
 *   }
 * })
 * ```
 *
 * @category context
 * @since 2.0.0
 */
export const serviceOption: <I, S>(key: Context.Key<I, S>) => Effect<Option<S>> = internal.serviceOption

/**
 * Provides part of the required context while leaving the rest unchanged.
 *
 * **Details**
 *
 * This function allows you to transform the context required by an effect,
 * providing part of the context and leaving the rest to be fulfilled later.
 *
 * **Example** (Updating the context before running)
 *
 * ```ts
 * import { Context, Effect } from "effect"
 *
 * // Define services
 * const Logger = Context.Service<{
 *   log: (msg: string) => void
 * }>("Logger")
 * const Config = Context.Service<{
 *   name: string
 * }>("Config")
 *
 * const program = Effect.service(Config).pipe(
 *   Effect.map((config) => `Hello ${config.name}!`)
 * )
 *
 * // Transform services by providing Config while keeping Logger requirement
 * const configured = program.pipe(
 *   Effect.updateContext((context: Context.Context<typeof Logger>) =>
 *     Context.add(context, Config, { name: "World" })
 *   )
 * )
 *
 * // The effect now requires only Logger service
 * const result = Effect.provideService(configured, Logger, {
 *   log: (msg) => console.log(msg)
 * })
 * ```
 *
 * @category context
 * @since 4.0.0
 */
export const updateContext: {
  <R2, R>(
    f: (context: Context.Context<R2>) => Context.Context<NoInfer<R>>
  ): <A, E>(self: Effect<A, E, R>) => Effect<A, E, R2>
  <A, E, R, R2>(
    self: Effect<A, E, R>,
    f: (context: Context.Context<R2>) => Context.Context<NoInfer<R>>
  ): Effect<A, E, R2>
} = internal.updateContext

/**
 * Runs an effect with a service implementation transformed by the provided
 * function.
 *
 * **Details**
 *
 * The service must be available in the effect's context; `updateService`
 * replaces it for the wrapped effect with the value returned by the updater.
 *
 * **Example** (Replacing a service for one effect)
 *
 * ```ts
 * import { Console, Context, Effect } from "effect"
 *
 * // Define a counter service
 * const Counter = Context.Service<{ count: number }>("Counter")
 *
 * const program = Effect.gen(function*() {
 *   const updatedCounter = yield* Effect.service(Counter)
 *   yield* Console.log(`Updated count: ${updatedCounter.count}`)
 *   return updatedCounter.count
 * }).pipe(
 *   Effect.updateService(Counter, (counter) => ({ count: counter.count + 1 }))
 * )
 *
 * // Provide initial service and run
 * const result = Effect.provideService(program, Counter, { count: 0 })
 * Effect.runPromise(result).then(console.log)
 * // Output: Updated count: 1
 * // 1
 * ```
 *
 * @category context
 * @since 2.0.0
 */
export const updateService: {
  <I, A>(
    service: Context.Key<I, A>,
    f: (value: A) => A
  ): <XA, E, R>(self: Effect<XA, E, R>) => Effect<XA, E, R | I>
  <XA, E, R, I, A>(
    self: Effect<XA, E, R>,
    service: Context.Key<I, A>,
    f: (value: A) => A
  ): Effect<XA, E, R | I>
} = internal.updateService

/**
 * Provides one concrete service implementation to an effect.
 *
 * **When to use**
 *
 * Use to satisfy one service requirement with an already-built implementation.
 *
 * **Details**
 *
 * The service requirement identified by the `Context.Key` is removed from the
 * effect requirements after the implementation is provided.
 *
 * **Example** (Providing a service value)
 *
 * ```ts
 * import { Console, Context, Effect } from "effect"
 *
 * // Define a service for configuration
 * const Config = Context.Service<{
 *   apiUrl: string
 *   timeout: number
 * }>("Config")
 *
 * const fetchData = Effect.gen(function*() {
 *   const config = yield* Effect.service(Config)
 *   yield* Console.log(`Fetching from: ${config.apiUrl}`)
 *   yield* Console.log(`Timeout: ${config.timeout}ms`)
 *   return "data"
 * })
 *
 * // Provide the service implementation
 * const program = Effect.provideService(fetchData, Config, {
 *   apiUrl: "https://api.example.com",
 *   timeout: 5000
 * })
 *
 * Effect.runPromise(program).then(console.log)
 * // Output:
 * // Fetching from: https://api.example.com
 * // Timeout: 5000ms
 * // data
 * ```
 *
 * @see {@link provide} for providing multiple layers to an effect.
 * @see {@link provideServiceEffect} for acquiring the service implementation effectfully.
 * @see {@link provideContext} for providing a complete context.
 * @category context
 * @since 2.0.0
 */
export const provideService: {
  <I, S>(
    service: Context.Key<I, S>
  ): {
    (implementation: S): <A, E, R>(self: Effect<A, E, R>) => Effect<A, E, Exclude<R, I>>
    <A, E, R>(self: Effect<A, E, R>, implementation: S): Effect<A, E, Exclude<R, I>>
  }
  <I, S>(
    service: Context.Key<I, S>,
    implementation: S
  ): <A, E, R>(self: Effect<A, E, R>) => Effect<A, E, Exclude<R, I>>
  <A, E, R, I, S>(
    self: Effect<A, E, R>,
    service: Context.Key<I, S>,
    implementation: S
  ): Effect<A, E, Exclude<R, I>>
} = internal.provideService

/**
 * Provides one service to an effect using an effectful acquisition.
 *
 * **Details**
 *
 * `provideServiceEffect` runs the acquisition effect to produce the service
 * implementation, removes that service from the wrapped effect's requirements,
 * and leaves any other requirements to be provided later. Acquisition failures
 * are included in the returned effect's error channel.
 *
 * **Example** (Providing a service with an effect)
 *
 * ```ts
 * import { Console, Context, Effect } from "effect"
 *
 * // Define a database connection service
 * interface DatabaseConnection {
 *   readonly query: (sql: string) => Effect.Effect<string>
 * }
 * const Database = Context.Service<DatabaseConnection>("Database")
 *
 * // Effect that creates a database connection
 * const createConnection = Effect.gen(function*() {
 *   yield* Console.log("Establishing database connection...")
 *   yield* Effect.sleep("100 millis") // Simulate connection time
 *   yield* Console.log("Database connected!")
 *   return {
 *     query: (sql: string) => Effect.succeed(`Result for: ${sql}`)
 *   }
 * })
 *
 * const program = Effect.gen(function*() {
 *   const db = yield* Effect.service(Database)
 *   return yield* db.query("SELECT * FROM users")
 * })
 *
 * // Provide the service through an effect
 * const withDatabase = Effect.provideServiceEffect(
 *   program,
 *   Database,
 *   createConnection
 * )
 *
 * Effect.runPromise(withDatabase).then(console.log)
 * // Output:
 * // Establishing database connection...
 * // Database connected!
 * // Result for: SELECT * FROM users
 * ```
 *
 * @category context
 * @since 2.0.0
 */
export const provideServiceEffect: {
  <I, S, E2, R2>(
    service: Context.Key<I, S>,
    acquire: Effect<S, E2, R2>
  ): <A, E, R>(self: Effect<A, E, R>) => Effect<A, E | E2, Exclude<R, I> | R2>
  <A, E, R, I, S, E2, R2>(
    self: Effect<A, E, R>,
    service: Context.Key<I, S>,
    acquire: Effect<S, E2, R2>
  ): Effect<A, E | E2, Exclude<R, I> | R2>
} = internal.provideServiceEffect

// -----------------------------------------------------------------------------
// References
// -----------------------------------------------------------------------------

/**
 * Sets the concurrency level for parallel operations within an effect.
 *
 * **Example** (Setting local concurrency)
 *
 * ```ts
 * import { Console, Effect } from "effect"
 *
 * const task = (id: number) =>
 *   Effect.gen(function*() {
 *     yield* Console.log(`Task ${id} starting`)
 *     yield* Effect.sleep("100 millis")
 *     yield* Console.log(`Task ${id} completed`)
 *     return id
 *   })
 *
 * // Run tasks with limited concurrency (max 2 at a time)
 * const program = Effect.gen(function*() {
 *   const tasks = [1, 2, 3, 4, 5].map(task)
 *   return yield* Effect.all(tasks, { concurrency: 2 })
 * }).pipe(
 *   Effect.withConcurrency(2)
 * )
 *
 * Effect.runPromise(program).then(console.log)
 * // Tasks will run with max 2 concurrent operations
 * // [1, 2, 3, 4, 5]
 * ```
 *
 * @category references
 * @since 2.0.0
 */
export const withConcurrency: {
  (
    concurrency: number | "unbounded"
  ): <A, E, R>(self: Effect<A, E, R>) => Effect<A, E, R>
  <A, E, R>(
    self: Effect<A, E, R>,
    concurrency: number | "unbounded"
  ): Effect<A, E, R>
} = internal.withConcurrency

// -----------------------------------------------------------------------------
// Resource management & finalization
// -----------------------------------------------------------------------------

/**
 * Returns the current scope for resource management.
 *
 * **Example** (Accessing the current scope)
 *
 * ```ts
 * import { Console, Effect } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const currentScope = yield* Effect.scope
 *   yield* Console.log("Got scope for resource management")
 *
 *   // Use the scope to manually manage resources if needed
 *   const resource = yield* Effect.acquireRelease(
 *     Console.log("Acquiring resource").pipe(Effect.as("resource")),
 *     () => Console.log("Releasing resource")
 *   )
 *
 *   return resource
 * })
 *
 * Effect.runPromise(Effect.scoped(program)).then(console.log)
 * // Output:
 * // Got scope for resource management
 * // Acquiring resource
 * // resource
 * // Releasing resource
 * ```
 *
 * @category resource management
 * @since 2.0.0
 */
export const scope: Effect<Scope, never, Scope> = internal.scope

/**
 * Runs an effect with a scope that closes when the effect completes.
 *
 * **When to use**
 *
 * Use to acquire scoped resources for the duration of a single workflow.
 *
 * **Details**
 *
 * Finalizers for resources acquired inside the workflow run as soon as the
 * workflow completes, whether by success, failure, or interruption.
 *
 * **Example** (Running a scoped acquisition)
 *
 * ```ts
 * import { Console, Effect } from "effect"
 *
 * const resource = Effect.acquireRelease(
 *   Console.log("Acquiring resource").pipe(Effect.as("resource")),
 *   () => Console.log("Releasing resource")
 * )
 *
 * const program = Effect.scoped(
 *   Effect.gen(function*() {
 *     const res = yield* resource
 *     yield* Console.log(`Using ${res}`)
 *     return res
 *   })
 * )
 *
 * Effect.runFork(program)
 * // Output: "Acquiring resource"
 * // Output: "Using resource"
 * // Output: "Releasing resource"
 * ```
 *
 * @category resource management
 * @since 2.0.0
 */
export const scoped: <A, E, R>(
  self: Effect<A, E, R>
) => Effect<A, E, Exclude<R, Scope>> = internal.scoped

/**
 * Creates a scoped effect by providing access to the scope.
 *
 * **Example** (Working with an explicit scope)
 *
 * ```ts
 * import { Console, Effect, Scope } from "effect"
 *
 * const program = Effect.scopedWith((scope) =>
 *   Effect.gen(function*() {
 *     yield* Console.log("Inside scoped context")
 *
 *     // Manually add a finalizer to the scope
 *     yield* Scope.addFinalizer(scope, Console.log("Manual finalizer"))
 *
 *     // Create a scoped resource
 *     const resource = yield* Effect.scoped(
 *       Effect.acquireRelease(
 *         Console.log("Acquiring resource").pipe(Effect.as("resource")),
 *         () => Console.log("Releasing resource")
 *       )
 *     )
 *
 *     return resource
 *   })
 * )
 *
 * Effect.runPromise(program).then(console.log)
 * // Output:
 * // Inside scoped context
 * // Acquiring resource
 * // resource
 * // Releasing resource
 * // Manual finalizer
 * ```
 *
 * @category resource management
 * @since 3.11.0
 */
export const scopedWith: <A, E, R>(
  f: (scope: Scope) => Effect<A, E, R>
) => Effect<A, E, R> = internal.scopedWith

/**
 * Constructs a scoped resource from an acquisition effect and a release
 * finalizer.
 *
 * **When to use**
 *
 * Use to acquire a scoped resource with an explicit release finalizer.
 *
 * **Details**
 *
 * If acquisition succeeds, the release finalizer is added to the current scope
 * and is guaranteed to run when that scope closes. The finalizer receives the
 * `Exit` value used to close the scope.
 *
 * By default, acquisition is protected by an uninterruptible region. Pass
 * `{ interruptible: true }` to allow the acquisition effect to be interrupted.
 *
 * **Example** (Acquiring and releasing a resource)
 *
 * ```ts
 * import { Console, Effect, Exit } from "effect"
 *
 * // Simulate a resource that needs cleanup
 * interface FileHandle {
 *   readonly path: string
 *   readonly content: string
 * }
 *
 * // Acquire a file handle
 * const acquire = Effect.gen(function*() {
 *   yield* Console.log("Opening file")
 *   return { path: "/tmp/file.txt", content: "file content" }
 * })
 *
 * // Release the file handle
 * const release = (handle: FileHandle, exit: Exit.Exit<unknown, unknown>) =>
 *   Console.log(
 *     `Closing file ${handle.path} with exit: ${
 *       Exit.isSuccess(exit) ? "success" : "failure"
 *     }`
 *   )
 *
 * // Create a scoped resource
 * const resource = Effect.acquireRelease(acquire, release)
 *
 * // Use the resource within a scope
 * const program = Effect.scoped(
 *   Effect.gen(function*() {
 *     const handle = yield* resource
 *     yield* Console.log(`Using file: ${handle.path}`)
 *     return handle.content
 *   })
 * )
 * ```
 *
 * @see {@link acquireDisposable} for resources that implement JavaScript disposal protocols
 * @see {@link acquireUseRelease} for bracketing acquire, use, and release in one effect
 *
 * @category resource management
 * @since 2.0.0
 */
export const acquireRelease: <A, E, R, R2>(
  acquire: Effect<A, E, R>,
  release: (a: A, exit: Exit.Exit<unknown, unknown>) => Effect<unknown, never, R2>,
  options?: { readonly interruptible?: boolean }
) => Effect<A, E, R | R2 | Scope> = internal.acquireRelease

/**
 * Acquires a scoped resource that implements JavaScript disposal protocols.
 *
 * **When to use**
 *
 * Use with JavaScript `Disposable` or `AsyncDisposable` resources that should
 * be closed with the surrounding scope.
 *
 * **Details**
 *
 * The resource is automatically disposed when the surrounding
 * {@link Scope} is closed, using {@link Symbol.dispose} for
 * synchronous disposables or {@link Symbol.asyncDispose} for asynchronous
 * disposables.
 *
 * This is similar to {@link acquireRelease}, but uses the standard
 * JavaScript disposal protocol instead of requiring an explicit release
 * function. It works with JavaScript `Disposable` and `AsyncDisposable`
 * resources.
 *
 * **Example** (Acquiring a disposable resource)
 *
 * ```ts
 * import sqlite from "node:sqlite";
 * import { Effect } from "effect"
 *
 * const program = Effect.scoped(
 *   Effect.gen(function* () {
 *     // acquire database connection
 *     // database will be closed when the scope is closed
 *     const db = yield* Effect.acquireDisposable(
 *       Effect.sync(() => new sqlite.DatabaseSync(":memory:"))
 *     )
 *
 *     const row = db.prepare("SELECT 1 AS value").get()
 *     yield* Effect.log(row) // { value: 1 }
 *   })
 * )
 * ```
 *
 * @see {@link acquireRelease} for resources that need an explicit finalizer
 *
 * @category resource management
 * @since 4.0.0
 */
export const acquireDisposable: <A extends AsyncDisposable | Disposable, E, R>(
  acquire: Effect<A, E, R>
) => Effect<A, E, R | Scope> = internal.acquireDisposable

/**
 * Runs resource acquisition, usage, and release as one bracketed effect.
 *
 * **When to use**
 *
 * Use to bracket acquire, use, and release logic in one effect.
 *
 * **Details**
 *
 * `acquireUseRelease` does the following:
 *
 *   1. Ensures that the `Effect` value that acquires the resource will not be
 *      interrupted. Note that acquisition may still fail due to internal
 *      reasons (such as an uncaught exception).
 *   2. Ensures that the `release` `Effect` value will not be interrupted,
 *      and will be executed as long as the acquisition `Effect` value
 *      successfully acquires the resource.
 *
 * During the time period between the acquisition and release of the resource,
 * the `use` `Effect` value will be executed.
 *
 * If the `release` `Effect` value fails, then the entire `Effect` value will
 * fail, even if the `use` `Effect` value succeeds. If this fail-fast behavior
 * is not desired, errors produced by the `release` `Effect` value can be caught
 * and ignored.
 *
 * **Example** (Using a resource with cleanup)
 *
 * ```ts
 * import { Console, Effect, Exit } from "effect"
 *
 * interface Database {
 *   readonly connection: string
 *   readonly query: (sql: string) => Effect.Effect<string>
 * }
 *
 * const program = Effect.acquireUseRelease(
 *   // Acquire - connect to database
 *   Effect.gen(function*() {
 *     yield* Console.log("Connecting to database...")
 *     return {
 *       connection: "db://localhost:5432",
 *       query: (sql: string) => Effect.succeed(`Result for: ${sql}`)
 *     }
 *   }),
 *   // Use - perform database operations
 *   (db) =>
 *     Effect.gen(function*() {
 *       yield* Console.log(`Connected to ${db.connection}`)
 *       const result = yield* db.query("SELECT * FROM users")
 *       yield* Console.log(`Query result: ${result}`)
 *       return result
 *     }),
 *   // Release - close database connection
 *   (db, exit) =>
 *     Effect.gen(function*() {
 *       if (Exit.isSuccess(exit)) {
 *         yield* Console.log(`Closing connection to ${db.connection} (success)`)
 *       } else {
 *         yield* Console.log(`Closing connection to ${db.connection} (failure)`)
 *       }
 *     })
 * )
 *
 * Effect.runPromise(program)
 * // Output:
 * // Connecting to database...
 * // Connected to db://localhost:5432
 * // Query result: Result for: SELECT * FROM users
 * // Closing connection to db://localhost:5432 (success)
 * ```
 *
 * @see {@link acquireRelease} for scoped resources whose use happens later
 *
 * @category resource management
 * @since 2.0.0
 */
export const acquireUseRelease: <Resource, E, R, A, E2, R2, E3, R3>(
  acquire: Effect<Resource, E, R>,
  use: (a: Resource) => Effect<A, E2, R2>,
  release: (a: Resource, exit: Exit.Exit<A, E2>) => Effect<void, E3, R3>
) => Effect<A, E | E2 | E3, R | R2 | R3> = internal.acquireUseRelease

/**
 * Adds a finalizer to the current scope.
 *
 * **When to use**
 *
 * Use to register low-level cleanup in the current scope.
 *
 * **Details**
 *
 * The finalizer runs when the surrounding scope is closed and receives the
 * `Exit` value used to close the scope.
 *
 * **Example** (Registering scope finalizers)
 *
 * ```ts
 * import { Console, Effect, Exit } from "effect"
 *
 * const program = Effect.scoped(
 *   Effect.gen(function*() {
 *     // Add a finalizer that runs when the scope closes
 *     yield* Effect.addFinalizer((exit) =>
 *       Console.log(
 *         Exit.isSuccess(exit)
 *           ? "Cleanup: Operation completed successfully"
 *           : "Cleanup: Operation failed, cleaning up resources"
 *       )
 *     )
 *
 *     yield* Console.log("Performing main operation...")
 *
 *     // This could succeed or fail
 *     return "operation result"
 *   })
 * )
 *
 * Effect.runPromise(program).then(console.log)
 * // Output:
 * // Performing main operation...
 * // Cleanup: Operation completed successfully
 * // operation result
 * ```
 *
 * @see {@link acquireRelease} for resource acquisition with a release finalizer
 * @see {@link ensuring} for attaching a finalizer to one effect
 *
 * @category resource management
 * @since 2.0.0
 */
export const addFinalizer: <R>(
  finalizer: (exit: Exit.Exit<unknown, unknown>) => Effect<void, never, R>
) => Effect<void, never, R | Scope> = internal.addFinalizer

/**
 * Returns an effect that, if this effect _starts_ execution, then the
 * specified `finalizer` is guaranteed to be executed, whether this effect
 * succeeds, fails, or is interrupted.
 *
 * **Details**
 *
 * For use cases that need access to the effect's result, see `onExit`.
 *
 * Finalizers offer very powerful guarantees, but they are low-level, and
 * should generally not be used for releasing resources. For higher-level
 * logic built on `ensuring`, see the `acquireRelease` family of methods.
 *
 * **Example** (Always running cleanup)
 *
 * ```ts
 * import { Console, Effect } from "effect"
 *
 * const task = Effect.gen(function*() {
 *   yield* Console.log("Task started")
 *   yield* Effect.sleep("1 second")
 *   yield* Console.log("Task completed")
 *   return 42
 * })
 *
 * // Ensure cleanup always runs, regardless of success or failure
 * const program = Effect.ensuring(
 *   task,
 *   Console.log("Cleanup: This always runs!")
 * )
 *
 * Effect.runPromise(program).then(console.log)
 * // Output:
 * // Task started
 * // Task completed
 * // Cleanup: This always runs!
 * // 42
 * ```
 *
 * @category resource management
 * @since 2.0.0
 */
export const ensuring: {
  <X, R1>(
    finalizer: Effect<X, never, R1>
  ): <A, E, R>(self: Effect<A, E, R>) => Effect<A, E, R1 | R>
  <A, E, R, X, R1>(
    self: Effect<A, E, R>,
    finalizer: Effect<X, never, R1>
  ): Effect<A, E, R1 | R>
} = internal.ensuring

/**
 * Runs the specified effect if this effect fails, providing the error to the
 * effect if it exists. The provided effect will not be interrupted.
 *
 * **Example** (Running cleanup on failure)
 *
 * ```ts
 * import { Cause, Console, Data, Effect } from "effect"
 *
 * class TaskError extends Data.TaggedError("TaskError")<{ readonly message: string }> {}
 *
 * const task = Effect.fail(new TaskError({ message: "Something went wrong" }))
 *
 * const program = Effect.onError(
 *   task,
 *   (cause) => Console.log(`Cleanup on error: ${Cause.squash(cause)}`)
 * )
 *
 * Effect.runPromise(program).catch(console.error)
 * // Output:
 * // Cleanup on error: TaskError: Something went wrong
 * // TaskError: Something went wrong
 * ```
 *
 * @category resource management
 * @since 2.0.0
 */
export const onError: {
  <E, X, R2>(
    cleanup: (cause: Cause.Cause<E>) => Effect<X, never, R2>
  ): <A, R>(self: Effect<A, E, R>) => Effect<A, E, R2 | R>
  <A, E, R, X, R2>(
    self: Effect<A, E, R>,
    cleanup: (cause: Cause.Cause<E>) => Effect<X, never, R2>
  ): Effect<A, E, R2 | R>
} = internal.onError

/**
 * Runs the finalizer only when this effect fails and the `Cause` matches the
 * provided predicate.
 *
 * **Example** (Running cleanup for selected failures)
 *
 * ```ts
 * import { Cause, Console, Effect } from "effect"
 *
 * const task = Effect.fail("boom")
 *
 * const program = Effect.onErrorIf(
 *   task,
 *   Cause.hasFails,
 *   (cause) =>
 *     Effect.gen(function*() {
 *       yield* Console.log(`Cause: ${Cause.pretty(cause)}`)
 *     })
 * )
 * ```
 *
 * @category resource management
 * @since 4.0.0
 */
export const onErrorIf: {
  <E, XE, XR>(
    predicate: Predicate.Predicate<Cause.Cause<E>>,
    f: (cause: Cause.Cause<E>) => Effect<void, XE, XR>
  ): <A, R>(self: Effect<A, E, R>) => Effect<A, E | XE, R | XR>
  <A, E, R, XE, XR>(
    self: Effect<A, E, R>,
    predicate: Predicate.Predicate<Cause.Cause<E>>,
    f: (cause: Cause.Cause<E>) => Effect<void, XE, XR>
  ): Effect<A, E | XE, R | XR>
} = internal.onErrorIf

/**
 * Runs the finalizer only when this effect fails and the cause matches the provided `Filter`.
 *
 * **When to use**
 *
 * Use when cleanup or diagnostics should run only for failures whose full
 * `Cause` is accepted or transformed by a `Filter`, and the finalizer needs the
 * filter's pass value plus the original cause.
 *
 * @see {@link onError} for cleanup on every failure
 * @see {@link onErrorIf} for selecting failures with a boolean predicate
 * @see {@link onExitFilter} for selecting from every exit instead of only failures
 *
 * @category resource management
 * @since 4.0.0
 */
export const onErrorFilter: {
  <A, E, EB, X, XE, XR>(
    filter: Filter.Filter<Cause.Cause<E>, EB, X>,
    f: (failure: EB, cause: Cause.Cause<E>) => Effect<void, XE, XR>
  ): <R>(self: Effect<A, E, R>) => Effect<A, E | XE, R | XR>
  <A, E, R, EB, X, XE, XR>(
    self: Effect<A, E, R>,
    filter: Filter.Filter<Cause.Cause<E>, EB, X>,
    f: (failure: EB, cause: Cause.Cause<E>) => Effect<void, XE, XR>
  ): Effect<A, E | XE, R | XR>
} = internal.onErrorFilter

/**
 * Runs an optional finalizer with the effect's `Exit` value when the effect
 * completes.
 *
 * **When to use**
 *
 * Use when you are building a low-level `Effect` operator that must inspect the
 * source effect's `Exit`, may skip finalization by returning `undefined`, or
 * must choose whether finalization is forced into an uninterruptible region.
 *
 * **Details**
 *
 * This low-level operator preserves the source effect's result unless the
 * finalizer fails. Prefer `onExit` for normal cleanup logic.
 *
 * @see {@link onExit} for ordinary exit-aware cleanup whose finalizer always returns an effect
 *
 * @category resource management
 * @since 4.0.0
 */
export const onExitPrimitive: <A, E, R, XE = never, XR = never>(
  self: Effect<A, E, R>,
  f: (exit: Exit.Exit<A, E>) => Effect<void, XE, XR> | undefined,
  interruptible?: boolean
) => Effect<A, E | XE, R | XR> = internal.onExitPrimitive

/**
 * Ensures that a cleanup function runs whether this effect succeeds, fails, or
 * is interrupted.
 *
 * **Example** (Observing every exit)
 *
 * ```ts
 * import { Console, Effect, Exit } from "effect"
 *
 * const task = Effect.succeed(42)
 *
 * const program = Effect.onExit(task, (exit) =>
 *   Console.log(
 *     Exit.isSuccess(exit)
 *       ? `Task succeeded with: ${exit.value}`
 *       : `Task failed: ${Exit.isFailure(exit) ? exit.cause : "interrupted"}`
 *   ))
 *
 * Effect.runPromise(program).then(console.log)
 * // Output:
 * // Task succeeded with: 42
 * // 42
 * ```
 *
 * @category resource management
 * @since 2.0.0
 */
export const onExit: {
  <A, E, XE = never, XR = never>(
    f: (exit: Exit.Exit<A, E>) => Effect<void, XE, XR>
  ): <R>(self: Effect<A, E, R>) => Effect<A, E | XE, R | XR>
  <A, E, R, XE = never, XR = never>(
    self: Effect<A, E, R>,
    f: (exit: Exit.Exit<A, E>) => Effect<void, XE, XR>
  ): Effect<A, E | XE, R | XR>
} = internal.onExit

/**
 * Runs the cleanup effect only when the `Exit` satisfies the provided
 * predicate.
 *
 * **Example** (Observing selected exits)
 *
 * ```ts
 * import { Console, Effect, Exit } from "effect"
 *
 * const program = Effect.onExitIf(
 *   Effect.succeed(42),
 *   Exit.isSuccess,
 *   (exit) =>
 *     Exit.isSuccess(exit)
 *       ? Console.log(`Succeeded with: ${exit.value}`)
 *       : Effect.void
 * )
 * ```
 *
 * @category resource management
 * @since 4.0.0
 */
export const onExitIf: {
  <A, E, XE, XR>(
    predicate: Predicate.Predicate<Exit.Exit<NoInfer<A>, NoInfer<E>>>,
    f: (exit: Exit.Exit<NoInfer<A>, NoInfer<E>>) => Effect<void, XE, XR>
  ): <R>(self: Effect<A, E, R>) => Effect<A, E | XE, R | XR>
  <A, E, R, XE, XR>(
    self: Effect<A, E, R>,
    predicate: Predicate.Predicate<Exit.Exit<NoInfer<A>, NoInfer<E>>>,
    f: (exit: Exit.Exit<NoInfer<A>, NoInfer<E>>) => Effect<void, XE, XR>
  ): Effect<A, E | XE, R | XR>
} = internal.onExitIf

/**
 * Runs the cleanup effect only when the `Exit` matches the provided `Filter`.
 *
 * **When to use**
 *
 * Use when cleanup should run only for `Exit` values selected by a `Filter`,
 * and the cleanup needs the extracted pass value together with the original
 * `Exit`.
 *
 * **Details**
 *
 * `Result.fail` skips cleanup, and `Result.succeed` runs cleanup with the
 * selected value and the original `Exit`.
 *
 * @see {@link onExit} for cleanup on every exit
 * @see {@link onExitIf} for selecting exits with a boolean predicate
 * @see {@link onErrorFilter} for selecting only failure causes
 *
 * @category resource management
 * @since 4.0.0
 */
export const onExitFilter: {
  <A, E, XE, XR, B, X>(
    filter: Filter.Filter<Exit.Exit<NoInfer<A>, NoInfer<E>>, B, X>,
    f: (b: B, exit: Exit.Exit<NoInfer<A>, NoInfer<E>>) => Effect<void, XE, XR>
  ): <R>(self: Effect<A, E, R>) => Effect<A, E | XE, R | XR>
  <A, E, R, XE, XR, B, X>(
    self: Effect<A, E, R>,
    filter: Filter.Filter<Exit.Exit<NoInfer<A>, NoInfer<E>>, B, X>,
    f: (b: B, exit: Exit.Exit<NoInfer<A>, NoInfer<E>>) => Effect<void, XE, XR>
  ): Effect<A, E | XE, R | XR>
} = internal.onExitFilter

// -----------------------------------------------------------------------------
// Caching
// -----------------------------------------------------------------------------

/**
 * Returns an effect that lazily computes a result and caches it for subsequent
 * evaluations.
 *
 * **When to use**
 *
 * Use when you use this function when you have an expensive or time-consuming operation that
 * you want to avoid repeating. The first evaluation will compute the result,
 * and all following evaluations will immediately return the cached value,
 * improving performance and reducing unnecessary work.
 *
 * **Details**
 *
 * This function wraps an effect and ensures that its result is computed only
 * once. Once the result is computed, it is cached, meaning that subsequent
 * evaluations of the same effect will return the cached result without
 * re-executing the logic.
 *
 * **Example** (Memoizing an effect until invalidated)
 *
 * ```ts
 * import { Console, Effect } from "effect"
 *
 * let i = 1
 * const expensiveTask = Effect.promise<string>(() => {
 *   console.log("expensive task...")
 *   return new Promise((resolve) => {
 *     setTimeout(() => {
 *       resolve(`result ${i++}`)
 *     }, 100)
 *   })
 * })
 *
 * const program = Effect.gen(function*() {
 *   console.log("non-cached version:")
 *   yield* expensiveTask.pipe(Effect.andThen(Console.log))
 *   yield* expensiveTask.pipe(Effect.andThen(Console.log))
 *   console.log("cached version:")
 *   const cached = yield* Effect.cached(expensiveTask)
 *   yield* cached.pipe(Effect.andThen(Console.log))
 *   yield* cached.pipe(Effect.andThen(Console.log))
 * })
 *
 * Effect.runFork(program)
 * // Output:
 * // non-cached version:
 * // expensive task...
 * // result 1
 * // expensive task...
 * // result 2
 * // cached version:
 * // expensive task...
 * // result 3
 * // result 3
 * ```
 *
 * @see {@link cachedWithTTL} for a similar function that includes a
 * time-to-live duration for the cached value.
 * @see {@link cachedInvalidateWithTTL} for a similar function that includes an
 * additional effect for manually invalidating the cached value.
 * @category caching
 * @since 2.0.0
 */
export const cached: <A, E, R>(self: Effect<A, E, R>) => Effect<Effect<A, E, R>> = internal.cached

/**
 * Returns an effect that caches its result for a specified `Duration`,
 * known as "timeToLive" (TTL).
 *
 * **When to use**
 *
 * Use when you use this function when you have an effect that involves costly operations or
 * computations, and you want to avoid repeating them within a short time frame.
 *
 * It's ideal for scenarios where the result of an effect doesn't change
 * frequently and can be reused for a specified duration.
 *
 * By caching the result, you can improve efficiency and reduce unnecessary
 * computations, especially in performance-critical applications.
 *
 * **Details**
 *
 * This function is used to cache the result of an effect for a specified amount
 * of time. This means that the first time the effect is evaluated, its result
 * is computed and stored.
 *
 * If the effect is evaluated again within the specified `timeToLive`, the
 * cached result will be used, avoiding recomputation.
 *
 * After the specified duration has passed, the cache expires, and the effect
 * will be recomputed upon the next evaluation.
 *
 * **Example** (Memoizing an effect with TTL)
 *
 * ```ts
 * import { Console, Effect } from "effect"
 *
 * let i = 1
 * const expensiveTask = Effect.promise<string>(() => {
 *   console.log("expensive task...")
 *   return new Promise((resolve) => {
 *     setTimeout(() => {
 *       resolve(`result ${i++}`)
 *     }, 100)
 *   })
 * })
 *
 * const program = Effect.gen(function*() {
 *   const cached = yield* Effect.cachedWithTTL(expensiveTask, "150 millis")
 *   yield* cached.pipe(Effect.andThen(Console.log))
 *   yield* cached.pipe(Effect.andThen(Console.log))
 *   yield* Effect.sleep("100 millis")
 *   yield* cached.pipe(Effect.andThen(Console.log))
 * })
 *
 * Effect.runFork(program)
 * // Output:
 * // expensive task...
 * // result 1
 * // result 1
 * // expensive task...
 * // result 2
 * ```
 *
 * @see {@link cached} for a similar function that caches the result
 * indefinitely.
 * @see {@link cachedInvalidateWithTTL} for a similar function that includes an
 * additional effect for manually invalidating the cached value.
 * @category caching
 * @since 2.0.0
 */
export const cachedWithTTL: {
  (timeToLive: Duration.Input): <A, E, R>(self: Effect<A, E, R>) => Effect<Effect<A, E, R>>
  <A, E, R>(self: Effect<A, E, R>, timeToLive: Duration.Input): Effect<Effect<A, E, R>>
} = internal.cachedWithTTL

/**
 * Creates a cached effect result for a specified duration and allows manual
 * invalidation before expiration.
 *
 * **When to use**
 *
 * Use when an effect result should be cached for a bounded time and callers
 * also need a manual invalidation effect to force recomputation before
 * expiration.
 *
 * **Details**
 *
 * This function behaves similarly to {@link cachedWithTTL} by caching the
 * result of an effect for a specified period of time. However, it introduces an
 * additional feature: it provides an effect that allows you to manually
 * invalidate the cached result before it naturally expires.
 *
 * This gives you more control over the cache, allowing you to refresh the
 * result when needed, even if the original cache has not yet expired.
 *
 * Once the cache is invalidated, the next time the effect is evaluated, the
 * result will be recomputed, and the cache will be refreshed.
 *
 * **Example** (Memoizing with TTL and invalidation)
 *
 * ```ts
 * import { Console, Effect } from "effect"
 *
 * let i = 1
 * const expensiveTask = Effect.promise<string>(() => {
 *   console.log("expensive task...")
 *   return new Promise((resolve) => {
 *     setTimeout(() => {
 *       resolve(`result ${i++}`)
 *     }, 100)
 *   })
 * })
 *
 * const program = Effect.gen(function*() {
 *   const [cached, invalidate] = yield* Effect.cachedInvalidateWithTTL(
 *     expensiveTask,
 *     "1 hour"
 *   )
 *   yield* cached.pipe(Effect.andThen(Console.log))
 *   yield* cached.pipe(Effect.andThen(Console.log))
 *   yield* invalidate
 *   yield* cached.pipe(Effect.andThen(Console.log))
 * })
 *
 * Effect.runFork(program)
 * // Output:
 * // expensive task...
 * // result 1
 * // result 1
 * // expensive task...
 * // result 2
 * ```
 *
 * @see {@link cached} for a similar function that caches the result
 * indefinitely.
 * @see {@link cachedWithTTL} for a similar function that caches the result for
 * a specified duration but does not include an effect for manual invalidation.
 * @category caching
 * @since 2.0.0
 */
export const cachedInvalidateWithTTL: {
  (timeToLive: Duration.Input): <A, E, R>(self: Effect<A, E, R>) => Effect<[Effect<A, E, R>, Effect<void>]>
  <A, E, R>(self: Effect<A, E, R>, timeToLive: Duration.Input): Effect<[Effect<A, E, R>, Effect<void>]>
} = internal.cachedInvalidateWithTTL

// -----------------------------------------------------------------------------
// Interruption
// -----------------------------------------------------------------------------

/**
 * Returns an effect that is immediately interrupted.
 *
 * **Example** (Creating an interrupted effect)
 *
 * ```ts
 * import { Effect } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   return yield* Effect.interrupt
 *   yield* Effect.succeed("This won't execute and is unreachable")
 * })
 *
 * Effect.runPromise(program).catch(console.error)
 * // Throws: InterruptedException
 * ```
 *
 * @category interruption
 * @since 2.0.0
 */
export const interrupt: Effect<never> = internal.interrupt

/**
 * Returns a new effect that allows the effect to be interruptible.
 *
 * **Example** (Allowing interruption)
 *
 * ```ts
 * import { Effect } from "effect"
 *
 * const longRunning = Effect.forever(Effect.succeed("working..."))
 *
 * const program = Effect.interruptible(longRunning)
 *
 * // This effect can now be interrupted
 * const fiber = Effect.runFork(program)
 * // Later: fiber.interrupt()
 * ```
 *
 * @category interruption
 * @since 2.0.0
 */
export const interruptible: <A, E, R>(
  self: Effect<A, E, R>
) => Effect<A, E, R> = internal.interruptible

/**
 * Runs the specified finalizer effect if this effect is interrupted.
 *
 * **Example** (Running cleanup on interruption)
 *
 * ```ts
 * import { Console, Effect, Fiber } from "effect"
 *
 * const task = Effect.forever(Effect.succeed("working..."))
 *
 * const program = Effect.onInterrupt(
 *   task,
 *   () => Console.log("Task was interrupted, cleaning up...")
 * )
 *
 * const fiber = Effect.runFork(program)
 * // Later interrupt the task
 * Effect.runFork(Fiber.interrupt(fiber))
 * // Output: Task was interrupted, cleaning up...
 * ```
 *
 * @category interruption
 * @since 2.0.0
 */
export const onInterrupt: {
  <XE, XR>(
    finalizer: (interruptors: ReadonlySet<number>) => Effect<void, XE, XR>
  ): <A, E, R>(self: Effect<A, E, R>) => Effect<A, E | XE, R | XR>
  <A, E, R, XE, XR>(
    self: Effect<A, E, R>,
    finalizer: (interruptors: ReadonlySet<number>) => Effect<void, XE, XR>
  ): Effect<A, E | XE, R | XR>
} = internal.onInterrupt

/**
 * Returns a new effect that disables interruption for the given effect.
 *
 * **Example** (Preventing interruption)
 *
 * ```ts
 * import { Console, Effect, Fiber } from "effect"
 *
 * const criticalTask = Effect.gen(function*() {
 *   yield* Console.log("Starting critical section...")
 *   yield* Effect.sleep("2 seconds")
 *   yield* Console.log("Critical section completed")
 * })
 *
 * const program = Effect.uninterruptible(criticalTask)
 *
 * const fiber = Effect.runFork(program)
 * // Even if interrupted, the critical task will complete
 * Effect.runPromise(Fiber.interrupt(fiber))
 * ```
 *
 * @category interruption
 * @since 2.0.0
 */
export const uninterruptible: <A, E, R>(
  self: Effect<A, E, R>
) => Effect<A, E, R> = internal.uninterruptible

/**
 * Disables interruption and provides a restore function to restore the
 * interruptible state within the effect.
 *
 * **Example** (Restoring interruption in protected regions)
 *
 * ```ts
 * import { Console, Effect } from "effect"
 *
 * const program = Effect.uninterruptibleMask((restore) =>
 *   Effect.gen(function*() {
 *     yield* Console.log("Uninterruptible phase...")
 *     yield* Effect.sleep("1 second")
 *
 *     // Restore interruptibility for this part
 *     yield* restore(
 *       Effect.gen(function*() {
 *         yield* Console.log("Interruptible phase...")
 *         yield* Effect.sleep("2 seconds")
 *       })
 *     )
 *
 *     yield* Console.log("Back to uninterruptible")
 *   })
 * )
 * ```
 *
 * @category interruption
 * @since 2.0.0
 */
export const uninterruptibleMask: <A, E, R>(
  f: (
    restore: <AX, EX, RX>(effect: Effect<AX, EX, RX>) => Effect<AX, EX, RX>
  ) => Effect<A, E, R>
) => Effect<A, E, R> = internal.uninterruptibleMask

/**
 * Runs an effect in an interruptible region while providing `restore` for
 * locally restoring the previous interruptibility.
 *
 * **Example** (Controlling interruptibility locally)
 *
 * ```ts
 * import { Console, Effect } from "effect"
 *
 * const program = Effect.interruptibleMask((restore) =>
 *   Effect.gen(function*() {
 *     yield* Console.log("Interruptible phase...")
 *     yield* Effect.sleep("1 second")
 *
 *     // Make this part uninterruptible
 *     yield* restore(
 *       Effect.gen(function*() {
 *         yield* Console.log("Uninterruptible phase...")
 *         yield* Effect.sleep("2 seconds")
 *       })
 *     )
 *
 *     yield* Console.log("Back to interruptible")
 *   })
 * )
 * ```
 *
 * @category interruption
 * @since 2.0.0
 */
export const interruptibleMask: <A, E, R>(
  f: (
    restore: <AX, EX, RX>(effect: Effect<AX, EX, RX>) => Effect<AX, EX, RX>
  ) => Effect<A, E, R>
) => Effect<A, E, R> = internal.interruptibleMask

/**
 * Creates an AbortSignal that is managed by the provided scope.
 *
 * **When to use**
 *
 * Use to obtain a scope-managed `AbortSignal` for APIs that accept cancellation
 * through a signal.
 *
 * **Details**
 *
 * Each acquisition creates a fresh `AbortController`. Closing the owning scope
 * runs a finalizer that aborts the controller and the effect succeeds with the
 * controller's signal.
 *
 * **Gotchas**
 *
 * The signal is aborted when its owning scope closes, so avoid keeping it for
 * work that outlives that scope.
 *
 * @see {@link scoped} for binding resource lifetime to a scope
 *
 * @category interruption
 * @since 4.0.0
 */
export const abortSignal: Effect<AbortSignal, never, Scope> = internal.abortSignal

// -----------------------------------------------------------------------------
// Repetition & Recursion
// -----------------------------------------------------------------------------

/**
 * Type helpers for repeating effects.
 *
 * @since 2.0.0
 */
export declare namespace Repeat {
  /**
   * Computes the result type of `Effect.repeat` from the original effect and repeat options.
   *
   * @category repetition / recursion
   * @since 2.0.0
   */
  export type Return<R, E, A, O extends Options<A>> = Effect<
    O extends { until: Predicate.Refinement<A, infer B> } ? B
      : O extends { while: Predicate.Refinement<A, infer B> } ? Exclude<A, B>
      : A,
    | E
    | (O extends { schedule: Schedule<infer _Out, infer _I, infer E, infer _R> } ? E
      : never)
    | (O extends { while: (...args: Array<any>) => Effect<infer _A, infer E, infer _R> } ? E
      : never)
    | (O extends { until: (...args: Array<any>) => Effect<infer _A, infer E, infer _R> } ? E
      : never),
    | R
    | (O extends { schedule: Schedule<infer _O, infer _I, infer _E, infer R> } ? R
      : never)
    | (O extends {
      while: (...args: Array<any>) => Effect<infer _A, infer _E, infer R>
    } ? R
      : never)
    | (O extends {
      until: (...args: Array<any>) => Effect<infer _A, infer _E, infer R>
    } ? R
      : never)
  > extends infer Z ? Z
    : never

  /**
   * Options that control whether and how an effect is repeated.
   *
   * @category repetition / recursion
   * @since 2.0.0
   */
  export interface Options<A> {
    while?: ((_: A) => boolean | Effect<boolean, any, any>) | undefined
    until?: ((_: A) => boolean | Effect<boolean, any, any>) | undefined
    times?: number | undefined
    schedule?: Schedule<any, A, any, any> | undefined
  }
}

/**
 * Repeats this effect forever (until the first error).
 *
 * **Example** (Repeating forever)
 *
 * ```ts
 * import { Console, Effect, Fiber } from "effect"
 *
 * const task = Effect.gen(function*() {
 *   yield* Console.log("Task running...")
 *   yield* Effect.sleep("1 second")
 * })
 *
 * // This will run forever, printing every second
 * const program = task.pipe(Effect.forever)
 *
 * // This will run forever, without yielding every iteration
 * const programNoYield = task.pipe(Effect.forever({ disableYield: true }))
 *
 * // Run for 5 seconds then interrupt
 * const timedProgram = Effect.gen(function*() {
 *   const fiber = yield* Effect.forkChild(program)
 *   yield* Effect.sleep("5 seconds")
 *   yield* Fiber.interrupt(fiber)
 * })
 * ```
 *
 * @category repetition / recursion
 * @since 2.0.0
 */
export const forever: <
  Arg extends Effect<any, any, any> | {
    readonly disableYield?: boolean | undefined
  } | undefined = {
    readonly disableYield?: boolean | undefined
  }
>(
  effectOrOptions?: Arg,
  options?: {
    readonly disableYield?: boolean | undefined
  } | undefined
) => [Arg] extends [Effect<infer _A, infer _E, infer _R>] ? Effect<never, _E, _R>
  : <A, E, R>(self: Effect<A, E, R>) => Effect<never, E, R> = internal.forever

/**
 * Repeats an effect based on a specified schedule or until the first failure.
 *
 * **When to use**
 *
 * Use to rerun an effect after successful executions.
 *
 * **Details**
 *
 * This function executes an effect repeatedly according to the given schedule.
 * Each repetition occurs after the initial execution of the effect, meaning
 * that the schedule determines the number of additional repetitions. For
 * example, using `Schedule.once` will result in the effect being executed twice
 * (once initially and once as part of the repetition).
 *
 * If the effect succeeds, it is repeated according to the schedule. If it
 * fails, the repetition stops immediately, and the failure is returned.
 *
 * The schedule can also specify delays between repetitions, making it useful
 * for tasks like retrying operations with backoff, periodic execution, or
 * performing a series of dependent actions.
 *
 * You can combine schedules for more advanced repetition logic, such as adding
 * delays, limiting recursions, or dynamically adjusting based on the outcome of
 * each execution.
 *
 * **Gotchas**
 *
 * The source effect is always evaluated once before the schedule is stepped.
 * The schedule controls additional repetitions, not the initial execution.
 *
 * **Example** (Repeating successful effects with a schedule)
 *
 * ```ts
 * // Success Example
 * import { Console, Effect, Schedule } from "effect"
 *
 * const action = Console.log("success")
 * const policy = Schedule.addDelay(Schedule.recurs(2), () => Effect.succeed("100 millis"))
 * const program = Effect.repeat(action, policy)
 *
 * // Effect.runPromise(program).then((n) => console.log(`repetitions: ${n}`))
 * ```
 *
 * **Example** (Stopping repetition on failure)
 *
 * ```ts
 * // Failure Example
 * import { Effect, Schedule } from "effect"
 *
 * let count = 0
 *
 * // Define a callback effect that simulates an action with possible failures
 * const action = Effect.callback<string, string>((resume) => {
 *   if (count > 1) {
 *     console.log("failure")
 *     resume(Effect.fail("Uh oh!"))
 *   } else {
 *     count++
 *     console.log("success")
 *     resume(Effect.succeed("yay!"))
 *   }
 * })
 *
 * const policy = Schedule.addDelay(Schedule.recurs(2), () => Effect.succeed("100 millis"))
 * const program = Effect.repeat(action, policy)
 *
 * // Effect.runPromiseExit(program).then(console.log)
 * ```
 *
 * @see {@link retry} for failure-based repetition
 * @see {@link repeatOrElse} for fallback handling when repetition fails
 *
 * @category repetition / recursion
 * @since 2.0.0
 */
export const repeat: {
  <O extends Repeat.Options<A>, A>(options: O): <E, R>(self: Effect<A, E, R>) => Repeat.Return<R, E, A, O>
  <Output, Input, Error, Env>(
    schedule: Schedule<Output, NoInfer<Input>, Error, Env>
  ): <E, R>(self: Effect<Input, E, R>) => Effect<Output, E | Error, R | Env>
  <Output, Input, Error, Env>(
    builder: (
      $: <O, E, R>(_: Schedule<O, NoInfer<Input>, E, R>) => Schedule<O, Input, E, R>
    ) => Schedule<Output, NoInfer<Input>, Error, Env>
  ): <E, R>(self: Effect<Input, E, R>) => Effect<Output, E | Error, R | Env>
  <A, E, R, O extends Repeat.Options<A>>(self: Effect<A, E, R>, options: O): Repeat.Return<R, E, A, O>
  <Input, E, R, Output, Error, Env>(
    self: Effect<Input, E, R>,
    schedule: Schedule<Output, NoInfer<Input>, Error, Env>
  ): Effect<Output, E | Error, R | Env>
  <Input, E, R, Output, Error, Env>(
    self: Effect<Input, E, R>,
    builder: (
      $: <O, E, R>(_: Schedule<O, NoInfer<Input>, E, R>) => Schedule<O, Input, E, R>
    ) => Schedule<Output, NoInfer<Input>, Error, Env>
  ): Effect<Output, E | Error, R | Env>
} = internalSchedule.repeat

/**
 * Repeats an effect according to a schedule and runs a fallback effect if
 * repetition fails before the schedule completes.
 *
 * **Details**
 *
 * If the repeated effect or schedule step fails, `orElse` receives the failure
 * and the latest schedule metadata when at least one schedule step has run;
 * otherwise it receives `None`. If the schedule completes normally, the
 * returned effect succeeds with the schedule's output.
 *
 * **Example** (Recovering after repetition stops)
 *
 * ```ts
 * import { Console, Effect, Option, Schedule } from "effect"
 *
 * let attempt = 0
 * const task = Effect.gen(function*() {
 *   attempt++
 *   if (attempt <= 2) {
 *     yield* Console.log(`Attempt ${attempt} failed`)
 *     return yield* Effect.fail(`Error ${attempt}`)
 *   }
 *   yield* Console.log(`Attempt ${attempt} succeeded`)
 *   return "success"
 * })
 *
 * const program = Effect.repeatOrElse(
 *   task,
 *   Schedule.recurs(3),
 *   (error, attempts) =>
 *     Console.log(
 *       `Final failure: ${error}, after ${
 *         Option.getOrElse(attempts, () => 0)
 *       } attempts`
 *     ).pipe(Effect.map(() => 0))
 * )
 * ```
 *
 * @category repetition / recursion
 * @since 2.0.0
 */
export const repeatOrElse: {
  <R2, A, B, E, E2, E3, R3>(
    schedule: Schedule<B, A, E2, R2>,
    orElse: (error: E | E2, option: Option<B>) => Effect<B, E3, R3>
  ): <R>(self: Effect<A, E, R>) => Effect<B, E3, R | R2 | R3>
  <A, E, R, R2, B, E2, E3, R3>(
    self: Effect<A, E, R>,
    schedule: Schedule<B, A, E2, R2>,
    orElse: (error: E | E2, option: Option<B>) => Effect<B, E3, R3>
  ): Effect<B, E3, R | R2 | R3>
} = internalSchedule.repeatOrElse

/**
 * Returns an array of `n` identical effects.
 *
 * **When to use**
 *
 * Use to create an array containing the same effect multiple times when you
 * want to pass those effects to another collector or control execution
 * separately.
 *
 * **Details**
 *
 * This only creates the array of effects. It does not run or collect them.
 *
 * @see {@link all} for running the returned effects and collecting results
 * @see {@link replicateEffect} for repeating an effect and collecting results in one step with concurrency and discard options
 *
 * @category collecting
 * @since 2.0.0
 */
export const replicate: {
  (n: number): <A, E, R>(self: Effect<A, E, R>) => Array<Effect<A, E, R>>
  <A, E, R>(self: Effect<A, E, R>, n: number): Array<Effect<A, E, R>>
} = internal.replicate

/**
 * Performs this effect `n` times and collects results with `Effect.all` semantics.
 *
 * **Details**
 *
 * Use `concurrency` to control parallelism and `discard: true` to ignore results.
 *
 * **Example** (Replicating an effect)
 *
 * ```ts
 * import { Console, Effect } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const results = yield* Effect.replicateEffect(3)(Effect.succeed(1))
 *   yield* Console.log(results)
 * })
 * ```
 *
 * @category collecting
 * @since 2.0.0
 */
export const replicateEffect: {
  (
    n: number,
    options?: { readonly concurrency?: Concurrency | undefined; readonly discard?: false | undefined }
  ): <A, E, R>(self: Effect<A, E, R>) => Effect<Array<A>, E, R>
  (
    n: number,
    options: { readonly concurrency?: Concurrency | undefined; readonly discard: true }
  ): <A, E, R>(self: Effect<A, E, R>) => Effect<void, E, R>
  <A, E, R>(
    self: Effect<A, E, R>,
    n: number,
    options?: { readonly concurrency?: Concurrency | undefined; readonly discard?: false | undefined }
  ): Effect<Array<A>, E, R>
  <A, E, R>(
    self: Effect<A, E, R>,
    n: number,
    options: { readonly concurrency?: Concurrency | undefined; readonly discard: true }
  ): Effect<void, E, R>
} = internal.replicateEffect

/**
 * Runs an effect repeatedly according to a schedule and returns the schedule's
 * final output.
 *
 * **When to use**
 *
 * Use to rerun a successful effect according to a `Schedule` when the schedule
 * does not need a custom initial input.
 *
 * **Details**
 *
 * The schedule is first stepped with `undefined`. After each successful
 * execution, the effect's success value is fed to the schedule to decide
 * whether to run again. The returned effect fails if the effect or schedule
 * fails, and otherwise succeeds with the schedule output when the schedule
 * completes.
 *
 * **Example** (Scheduling repeated execution)
 *
 * ```ts
 * import { Console, Effect, Schedule } from "effect"
 *
 * const task = Effect.gen(function*() {
 *   yield* Console.log("Task executing...")
 *   return Math.random()
 * })
 *
 * // Repeat 3 times with 1 second delay between executions
 * const program = Effect.schedule(
 *   task,
 *   Schedule.addDelay(Schedule.recurs(2), () => Effect.succeed("1 second"))
 * )
 *
 * Effect.runPromise(program).then(console.log)
 * // Output:
 * // Task executing... (immediate)
 * // Task executing... (after 1 second)
 * // Task executing... (after 1 second)
 * // Returns the count from Schedule.recurs
 * ```
 *
 * @see {@link scheduleFrom} for a variant that allows the schedule's decision
 * to depend on the result of this effect.
 *
 * @category repetition / recursion
 * @since 2.0.0
 */
export const schedule: {
  <Output, Error, Env>(
    schedule: Schedule<Output, unknown, Error, Env>
  ): <A, E, R>(self: Effect<A, E, R>) => Effect<Output, E, R | Env>
  <A, E, R, Output, Error, Env>(
    self: Effect<A, E, R>,
    schedule: Schedule<Output, unknown, Error, Env>
  ): Effect<Output, E, R | Env>
} = dual(2, <A, E, R, Output, Error, Env>(
  self: Effect<A, E, R>,
  schedule: Schedule<Output, unknown, Error, Env>
): Effect<Output, E, R | Env> => scheduleFrom(self, undefined, schedule))

/**
 * Runs an effect repeatedly according to a schedule that is initialized with a
 * specific schedule input.
 *
 * **Details**
 *
 * `initial` is passed to the schedule before the first execution, not to the
 * effect itself. After each successful execution, the effect's success value is
 * fed back into the schedule to decide whether to continue. The returned effect
 * succeeds with the schedule output when the schedule completes and fails if
 * the effect or schedule fails.
 *
 * **Example** (Scheduling from an initial value)
 *
 * ```ts
 * import { Console, Effect, Schedule } from "effect"
 *
 * const task = (input: number) =>
 *   Effect.gen(function*() {
 *     yield* Console.log(`Processing: ${input}`)
 *     return input + 1
 *   })
 *
 * // Start with 0, repeat 3 times
 * const program = Effect.scheduleFrom(
 *   task(0),
 *   0,
 *   Schedule.recurs(2)
 * )
 *
 * Effect.runPromise(program).then(console.log)
 * // Returns the schedule count
 * ```
 *
 * @category repetition / recursion
 * @since 2.0.0
 */
export const scheduleFrom: {
  <Input, Output, Error, Env>(
    initial: Input,
    schedule: Schedule<Output, Input, Error, Env>
  ): <E, R>(self: Effect<Input, E, R>) => Effect<Output, E, R | Env>
  <Input, E, R, Output, Error, Env>(
    self: Effect<Input, E, R>,
    initial: Input,
    schedule: Schedule<Output, Input, Error, Env>
  ): Effect<Output, E, R | Env>
} = internalSchedule.scheduleFrom

// -----------------------------------------------------------------------------
// Tracing
// -----------------------------------------------------------------------------

/**
 * Returns the current tracer from the context.
 *
 * **Example** (Accessing the current tracer)
 *
 * ```ts
 * import { Effect } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const currentTracer = yield* Effect.tracer
 *   yield* Effect.log(`Using tracer: ${currentTracer}`)
 *   return "operation completed"
 * })
 * ```
 *
 * @category tracing
 * @since 2.0.0
 */
export const tracer: Effect<Tracer> = internal.tracer

/**
 * Provides a tracer to an effect.
 *
 * **Example** (Providing a tracer)
 *
 * ```ts
 * import { Effect } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   yield* Effect.log("Using tracer")
 *   return "completed"
 * })
 *
 * // withTracer provides a tracer to the effect context
 * // const traced = Effect.withTracer(program, customTracer)
 * ```
 *
 * @category tracing
 * @since 2.0.0
 */
export const withTracer: {
  (value: Tracer): <A, E, R>(effect: Effect<A, E, R>) => Effect<A, E, R>
  <A, E, R>(effect: Effect<A, E, R>, value: Tracer): Effect<A, E, R>
} = internal.withTracer

/**
 * Enables or disables tracing for spans created by the given effect.
 *
 * **Details**
 *
 * When `enabled` is `false`, spans created inside the effect are not registered
 * with the current tracer and do not propagate as normal trace parents.
 *
 * **Example** (Enabling or disabling tracing)
 *
 * ```ts
 * import { Effect } from "effect"
 *
 * Effect.succeed(42).pipe(
 *   Effect.withSpan("my-span"),
 *   // the span will not be registered with the tracer
 *   Effect.withTracerEnabled(false)
 * )
 * ```
 *
 * @category tracing
 * @since 2.0.0
 */
export const withTracerEnabled: {
  (enabled: boolean): <A, E, R>(effect: Effect<A, E, R>) => Effect<A, E, R>
  <A, E, R>(effect: Effect<A, E, R>, enabled: boolean): Effect<A, E, R>
} = internal.withTracerEnabled

/**
 * Enables or disables tracer timing for the given Effect.
 *
 * **Example** (Enabling or disabling tracing timing)
 *
 * ```ts
 * import { Effect } from "effect"
 *
 * Effect.succeed(42).pipe(
 *   Effect.withSpan("my-span"),
 *   // the span will not have timing information
 *   Effect.withTracerTiming(false)
 * )
 * ```
 *
 * @category tracing
 * @since 2.0.0
 */
export const withTracerTiming: {
  (enabled: boolean): <A, E, R>(effect: Effect<A, E, R>) => Effect<A, E, R>
  <A, E, R>(effect: Effect<A, E, R>, enabled: boolean): Effect<A, E, R>
} = internal.withTracerTiming

/**
 * Adds an annotation to each span in this effect.
 *
 * **Example** (Annotating all spans)
 *
 * ```ts
 * import { Effect } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   yield* Effect.log("Doing some work...")
 *   return "result"
 * })
 *
 * // Add single annotation
 * const annotated1 = Effect.annotateSpans(program, "user", "john")
 *
 * // Add multiple annotations
 * const annotated2 = Effect.annotateSpans(program, {
 *   operation: "data-processing",
 *   version: "1.0.0",
 *   environment: "production"
 * })
 * ```
 *
 * @category tracing
 * @since 2.0.0
 */
export const annotateSpans: {
  (
    key: string,
    value: unknown
  ): <A, E, R>(effect: Effect<A, E, R>) => Effect<A, E, R>
  (
    values: Record<string, unknown>
  ): <A, E, R>(effect: Effect<A, E, R>) => Effect<A, E, R>
  <A, E, R>(
    effect: Effect<A, E, R>,
    key: string,
    value: unknown
  ): Effect<A, E, R>
  <A, E, R>(
    effect: Effect<A, E, R>,
    values: Record<string, unknown>
  ): Effect<A, E, R>
} = internal.annotateSpans

/**
 * Adds an annotation to the current span if available.
 *
 * **Example** (Annotating the current span)
 *
 * ```ts
 * import { Effect } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   yield* Effect.annotateCurrentSpan("userId", "123")
 *   yield* Effect.annotateCurrentSpan({
 *     operation: "user-lookup",
 *     timestamp: Date.now()
 *   })
 *   yield* Effect.log("User lookup completed")
 *   return "success"
 * })
 *
 * const traced = Effect.withSpan(program, "user-operation")
 * ```
 *
 * @category tracing
 * @since 2.0.0
 */
export const annotateCurrentSpan: {
  (key: string, value: unknown): Effect<void>
  (values: Record<string, unknown>): Effect<void>
} = internal.annotateCurrentSpan

/**
 * Returns the currently active local tracing span.
 *
 * **Details**
 *
 * The effect fails with `NoSuchElementError` when there is no active local
 * `Span`.
 *
 * **Example** (Reading the current span)
 *
 * ```ts
 * import { Effect } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const span = yield* Effect.currentSpan
 *   yield* Effect.log(`Current span: ${span}`)
 *   return "done"
 * })
 *
 * const traced = Effect.withSpan(program, "my-span")
 * ```
 *
 * @category tracing
 * @since 2.0.0
 */
export const currentSpan: Effect<Span, Cause.NoSuchElementError> = internal.currentSpan

/**
 * Returns the current parent span from the effect context.
 *
 * **Details**
 *
 * The effect succeeds with either a local span or external span when one is
 * present, and fails with `NoSuchElementError` when no parent span is
 * available.
 *
 * **Example** (Reading the parent span)
 *
 * ```ts
 * import { Effect } from "effect"
 *
 * const childOperation = Effect.gen(function*() {
 *   const parentSpan = yield* Effect.currentParentSpan
 *   yield* Effect.log(`Parent span: ${parentSpan}`)
 *   return "child completed"
 * })
 *
 * const program = Effect.gen(function*() {
 *   yield* Effect.withSpan(childOperation, "child-span")
 *   return "parent completed"
 * })
 *
 * const traced = Effect.withSpan(program, "parent-span")
 * ```
 *
 * @category tracing
 * @since 2.0.0
 */
export const currentParentSpan: Effect<AnySpan, Cause.NoSuchElementError> = internal.currentParentSpan

/**
 * Returns the tracing span annotations currently carried in the effect context.
 *
 * **Details**
 *
 * These annotations are applied to spans created inside the context, such as
 * spans created by `withSpan`, `useSpan`, or `makeSpan`.
 *
 * **Example** (Providing span annotations)
 *
 * ```ts
 * import { Effect } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   // Add some annotations to the current span
 *   yield* Effect.annotateCurrentSpan("userId", "123")
 *   yield* Effect.annotateCurrentSpan("operation", "data-processing")
 *
 *   // Retrieve all annotations
 *   const annotations = yield* Effect.spanAnnotations
 *
 *   console.log("Current span annotations:", annotations)
 *   return annotations
 * })
 *
 * Effect.runPromise(program).then(console.log)
 * // Output: Current span annotations: { userId: "123", operation: "data-processing" }
 * ```
 *
 * @category tracing
 * @since 2.0.0
 */
export const spanAnnotations: Effect<Readonly<Record<string, unknown>>> = internal.spanAnnotations

/**
 * Returns the tracing span links currently carried in the effect context.
 *
 * **Details**
 *
 * These links are attached to spans created inside the context. Span links
 * connect related spans without making one span the parent of another.
 *
 * **Example** (Providing span links)
 *
 * ```ts
 * import { Effect } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   // Get the current span links
 *   const links = yield* Effect.spanLinks
 *   console.log(`Current span has ${links.length} links`)
 *   return links
 * })
 * ```
 *
 * @category tracing
 * @since 2.0.0
 */
export const spanLinks: Effect<ReadonlyArray<SpanLink>> = internal.spanLinks

/**
 * Adds a link with the provided span to all spans in this effect.
 *
 * **Details**
 *
 * This is useful for connecting spans that are related but not in a direct
 * parent-child relationship. For example, you might want to link spans from
 * parallel operations or connect spans across different traces.
 *
 * **Example** (Linking one span to another span)
 *
 * ```ts
 * import { Effect } from "effect"
 *
 * const parentEffect = Effect.withSpan("parent-operation")(
 *   Effect.succeed("parent result")
 * )
 *
 * const childEffect = Effect.withSpan("child-operation")(
 *   Effect.succeed("child result")
 * )
 *
 * // Link the child span to the parent span
 * const program = Effect.gen(function*() {
 *   const parentSpan = yield* Effect.currentSpan
 *   const result = yield* childEffect.pipe(
 *     Effect.linkSpans(parentSpan, { relationship: "follows" })
 *   )
 *   return result
 * })
 * ```
 *
 * **Example** (Linking multiple spans at once)
 *
 * ```ts
 * import { Effect } from "effect"
 *
 * // Link multiple spans
 * const program = Effect.gen(function*() {
 *   const span1 = yield* Effect.currentSpan
 *   const span2 = yield* Effect.currentSpan
 *
 *   return yield* Effect.succeed("result").pipe(
 *     Effect.linkSpans([span1, span2], {
 *       type: "dependency",
 *       source: "multiple-operations"
 *     })
 *   )
 * })
 * ```
 *
 * @category tracing
 * @since 2.0.0
 */
export const linkSpans: {
  (
    span: AnySpan | ReadonlyArray<AnySpan>,
    attributes?: Record<string, unknown>
  ): <A, E, R>(self: Effect<A, E, R>) => Effect<A, E, R>
  <A, E, R>(
    self: Effect<A, E, R>,
    span: AnySpan | ReadonlyArray<AnySpan>,
    attributes?: Record<string, unknown>
  ): Effect<A, E, R>
} = internal.linkSpans

/**
 * Creates a new tracing span and returns it without managing its lifetime.
 *
 * **Details**
 *
 * The span is not added to the current span stack and is not ended
 * automatically. Use `withSpan`, `useSpan`, or `makeSpanScoped` when the span
 * should be installed as context or closed automatically.
 *
 * **Example** (Creating a span manually)
 *
 * ```ts
 * import { Effect } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const span = yield* Effect.makeSpan("my-operation")
 *   yield* Effect.log("Operation in progress")
 *   return "completed"
 * })
 * ```
 *
 * @category tracing
 * @since 2.0.0
 */
export const makeSpan: (name: string, options?: SpanOptionsNoTrace) => Effect<Span> = internal.makeSpan

/**
 * Create a new span for tracing, and automatically close it when the Scope
 * finalizes.
 *
 * **Details**
 *
 * The span is not added to the current span stack, so no child spans will be
 * created for it.
 *
 * **Example** (Creating a scoped standalone span)
 *
 * ```ts
 * import { Effect } from "effect"
 *
 * const program = Effect.scoped(
 *   Effect.gen(function*() {
 *     const span = yield* Effect.makeSpanScoped("scoped-operation")
 *     yield* Effect.log("Working...")
 *     return "done"
 *     // Span automatically closes when scope ends
 *   })
 * )
 * ```
 *
 * @category tracing
 * @since 2.0.0
 */
export const makeSpanScoped: (
  name: string,
  options?: SpanOptionsNoTrace | undefined
) => Effect<Span, never, Scope> = internal.makeSpanScoped

/**
 * Create a new span for tracing, and automatically close it when the effect
 * completes.
 *
 * **Details**
 *
 * The span is not added to the current span stack, so no child spans will be
 * created for it.
 *
 * **Example** (Running an effect with a standalone span)
 *
 * ```ts
 * import { Effect } from "effect"
 *
 * const program = Effect.useSpan(
 *   "user-operation",
 *   (span) =>
 *     Effect.gen(function*() {
 *       yield* Effect.log("Processing user data")
 *       return "success"
 *     })
 * )
 * ```
 *
 * @category tracing
 * @since 2.0.0
 */
export const useSpan: {
  <A, E, R>(name: string, evaluate: (span: Span) => Effect<A, E, R>): Effect<A, E, R>
  <A, E, R>(name: string, options: SpanOptionsNoTrace, evaluate: (span: Span) => Effect<A, E, R>): Effect<A, E, R>
} = internal.useSpan

/**
 * Wraps the effect with a child span for tracing.
 *
 * **Example** (Wrapping an effect in a child span)
 *
 * ```ts
 * import { Effect } from "effect"
 *
 * const task = Effect.gen(function*() {
 *   yield* Effect.log("Executing task")
 *   return "result"
 * })
 *
 * const traced = Effect.withSpan(task, "my-task", {
 *   attributes: { version: "1.0" }
 * })
 * ```
 *
 * @category tracing
 * @since 2.0.0
 */
export const withSpan: {
  <Args extends ReadonlyArray<any>>(
    name: string,
    options?:
      | SpanOptionsNoTrace
      | ((...args: NoInfer<Args>) => SpanOptionsNoTrace)
      | undefined,
    traceOptions?: TraceOptions | undefined
  ): <A, E, R>(self: Effect<A, E, R>, ...args: Args) => Effect<A, E, Exclude<R, ParentSpan>>
  <A, E, R>(
    self: Effect<A, E, R>,
    name: string,
    options?: SpanOptions | undefined
  ): Effect<A, E, Exclude<R, ParentSpan>>
} = internal.withSpan

/**
 * Wraps the effect with a scoped child span for tracing.
 *
 * **Details**
 *
 * The span is ended when the Scope is finalized.
 *
 * **Example** (Creating a scoped child span)
 *
 * ```ts
 * import { Effect } from "effect"
 *
 * const program = Effect.scoped(
 *   Effect.gen(function*() {
 *     const task = Effect.log("Working...")
 *     yield* Effect.withSpanScoped(task, "scoped-task")
 *     return "completed"
 *   })
 * )
 * ```
 *
 * @category tracing
 * @since 2.0.0
 */
export const withSpanScoped: {
  (
    name: string,
    options?: SpanOptions
  ): <A, E, R>(
    self: Effect<A, E, R>
  ) => Effect<A, E, Exclude<R, ParentSpan> | Scope>
  <A, E, R>(
    self: Effect<A, E, R>,
    name: string,
    options?: SpanOptions
  ): Effect<A, E, Exclude<R, ParentSpan> | Scope>
} = internal.withSpanScoped

/**
 * Adds the provided span to the current span stack.
 *
 * **Example** (Setting a parent span)
 *
 * ```ts
 * import { Effect } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const span = yield* Effect.makeSpan("parent-span")
 *   const childTask = Effect.log("Child operation")
 *   yield* Effect.withParentSpan(childTask, span)
 *   return "completed"
 * })
 * ```
 *
 * @category tracing
 * @since 2.0.0
 */
export const withParentSpan: {
  (value: AnySpan, options?: TraceOptions): <A, E, R>(self: Effect<A, E, R>) => Effect<A, E, Exclude<R, ParentSpan>>
  <A, E, R>(self: Effect<A, E, R>, value: AnySpan, options?: TraceOptions): Effect<A, E, Exclude<R, ParentSpan>>
} = internal.withParentSpan

// -----------------------------------------------------------------------------
// Batching
// -----------------------------------------------------------------------------

/**
 * Executes a request using the provided resolver.
 *
 * **When to use**
 *
 * Use to execute a typed `Request` through a `RequestResolver` when you want
 * concurrent requests made with the same resolver to be collected and completed
 * by resolver logic.
 *
 * **Example** (Executing a request through a resolver)
 *
 * ```ts
 * import { Console, Effect, Exit, Request, RequestResolver } from "effect"
 *
 * interface GetUser extends Request.Request<string> {
 *   readonly _tag: "GetUser"
 *   readonly id: number
 * }
 * const GetUser = Request.tagged<GetUser>("GetUser")
 *
 * const resolver = RequestResolver.make<GetUser>(
 *   Effect.fnUntraced(function*(entries) {
 *     for (const entry of entries) {
 *       yield* Request.complete(entry, Exit.succeed(`user-${entry.request.id}`))
 *     }
 *   })
 * )
 *
 * const program = Effect.gen(function*() {
 *   const name = yield* Effect.request(GetUser({ id: 1 }), resolver)
 *   yield* Console.log(name)
 * })
 * ```
 *
 * @see {@link requestUnsafe} for the low-level entry point when you already have a `Context` and need to enqueue outside an `Effect`
 *
 * @category requests & batching
 * @since 2.0.0
 */
export const request: {
  <A extends Request.Any, EX = never, RX = never>(
    resolver: RequestResolver<A> | Effect<RequestResolver<A>, EX, RX>
  ): (self: A) => Effect<Request.Success<A>, Request.Error<A> | EX, Request.Services<A> | RX>
  <A extends Request.Any, EX = never, RX = never>(
    self: A,
    resolver: RequestResolver<A> | Effect<RequestResolver<A>, EX, RX>
  ): Effect<Request.Success<A>, Request.Error<A> | EX, Request.Services<A> | RX>
} = internalRequest.request

/**
 * Registers a request with a resolver and delivers the exit value via `onExit`.
 *
 * **When to use**
 *
 * Use when you already have a `Context` and need to enqueue a request outside
 * an `Effect` while receiving completion through `onExit`.
 *
 * **Details**
 *
 * It returns a canceler that removes the pending request entry.
 *
 * @see {@link request} for the `Effect`-returning API used for normal request execution
 *
 * @category requests & batching
 * @since 4.0.0
 */
export const requestUnsafe: <A extends Request.Any>(
  self: A,
  options: {
    readonly resolver: RequestResolver<A>
    readonly onExit: (exit: Exit.Exit<Request.Success<A>, Request.Error<A>>) => void
    readonly context: Context.Context<never>
  }
) => () => void = internalRequest.requestUnsafe

// -----------------------------------------------------------------------------
// Supervision & Fiber's
// -----------------------------------------------------------------------------

/**
 * Returns an effect that forks this effect into its own separate fiber,
 * returning the fiber immediately, without waiting for it to begin executing
 * the effect.
 *
 * **Details**
 *
 * You can use the `forkChild` method whenever you want to execute an effect in a
 * new fiber, concurrently and without "blocking" the fiber executing other
 * effects. Using fibers can be tricky, so instead of using this method
 * directly, consider other higher-level methods, such as `raceWith`,
 * `zipPar`, and so forth.
 *
 * The fiber returned by this method has methods to interrupt the fiber and to
 * wait for it to finish executing the effect. See `Fiber` for more
 * information.
 *
 * Whenever you use this method to launch a new fiber, the new fiber is
 * attached to the parent fiber's scope. This means when the parent fiber
 * terminates, the child fiber will be terminated as well, ensuring that no
 * fibers leak. This behavior is called "auto supervision", and if this
 * behavior is not desired, you may use the `forkDetach` or `forkIn` methods.
 *
 * **Example** (Forking a child fiber)
 *
 * ```ts
 * import { Effect, Fiber } from "effect"
 *
 * const longRunningTask = Effect.gen(function*() {
 *   yield* Effect.sleep("2 seconds")
 *   yield* Effect.log("Task completed")
 *   return "result"
 * })
 *
 * const program = Effect.gen(function*() {
 *   const fiber = yield* longRunningTask.pipe(Effect.forkChild)
 *
 *   // or fork a fiber that starts immediately:
 *   yield* longRunningTask.pipe(Effect.forkChild({ startImmediately: true }))
 *
 *   yield* Effect.log("Task forked, continuing...")
 *   const result = yield* Fiber.join(fiber)
 *   return result
 * })
 * ```
 *
 * @category supervision & fibers
 * @since 4.0.0
 */
export const forkChild: <
  Arg extends Effect<any, any, any> | {
    readonly startImmediately?: boolean | undefined
    readonly uninterruptible?: boolean | "inherit" | undefined
  } | undefined = {
    readonly startImmediately?: boolean | undefined
    readonly uninterruptible?: boolean | "inherit" | undefined
  }
>(
  effectOrOptions?: Arg,
  options?: {
    readonly startImmediately?: boolean | undefined
    readonly uninterruptible?: boolean | "inherit" | undefined
  } | undefined
) => [Arg] extends [Effect<infer _A, infer _E, infer _R>] ? Effect<Fiber<_A, _E>, never, _R>
  : <A, E, R>(self: Effect<A, E, R>) => Effect<Fiber<A, E>, never, R> = internal.forkChild

/**
 * Forks the effect in the specified scope. The fiber will be interrupted
 * when the scope is closed.
 *
 * **Example** (Forking into a supplied scope)
 *
 * ```ts
 * import { Effect } from "effect"
 *
 * const task = Effect.gen(function*() {
 *   yield* Effect.sleep("10 seconds")
 *   return "completed"
 * })
 *
 * const program = Effect.scoped(
 *   Effect.gen(function*() {
 *     const scope = yield* Effect.scope
 *     const fiber = yield* Effect.forkIn(task, scope)
 *     yield* Effect.sleep("1 second")
 *     // Fiber will be interrupted when scope closes
 *     return "done"
 *   })
 * )
 * ```
 *
 * @category supervision & fibers
 * @since 2.0.0
 */
export const forkIn: {
  (
    scope: Scope,
    options?: {
      readonly startImmediately?: boolean | undefined
      readonly uninterruptible?: boolean | "inherit" | undefined
    }
  ): <A, E, R>(self: Effect<A, E, R>) => Effect<Fiber<A, E>, never, R>
  <A, E, R>(
    self: Effect<A, E, R>,
    scope: Scope,
    options?: {
      readonly startImmediately?: boolean | undefined
      readonly uninterruptible?: boolean | "inherit" | undefined
    }
  ): Effect<Fiber<A, E>, never, R>
} = internal.forkIn

/**
 * Forks the fiber in a `Scope`, interrupting it when the scope is closed.
 *
 * **Example** (Forking into the current scope)
 *
 * ```ts
 * import { Effect } from "effect"
 *
 * const backgroundTask = Effect.gen(function*() {
 *   yield* Effect.sleep("5 seconds")
 *   yield* Effect.log("Background task completed")
 *   return "result"
 * })
 *
 * const program = Effect.scoped(
 *   Effect.gen(function*() {
 *     const fiber = yield* backgroundTask.pipe(Effect.forkScoped)
 *
 *     // or fork a fiber that starts immediately:
 *     yield* backgroundTask.pipe(Effect.forkScoped({ startImmediately: true }))
 *
 *     yield* Effect.log("Task forked in scope")
 *     yield* Effect.sleep("1 second")
 *
 *     // Fiber will be interrupted when scope closes
 *     return "scope completed"
 *   })
 * )
 * ```
 *
 * @category supervision & fibers
 * @since 2.0.0
 */
export const forkScoped: <
  Arg extends Effect<any, any, any> | {
    readonly startImmediately?: boolean | undefined
    readonly uninterruptible?: boolean | "inherit" | undefined
  } | undefined = {
    readonly startImmediately?: boolean | undefined
    readonly uninterruptible?: boolean | "inherit" | undefined
  }
>(
  effectOrOptions?: Arg,
  options?: {
    readonly startImmediately?: boolean | undefined
    readonly uninterruptible?: boolean | "inherit" | undefined
  } | undefined
) => [Arg] extends [Effect<infer _A, infer _E, infer _R>] ? Effect<Fiber<_A, _E>, never, _R | Scope>
  : <A, E, R>(self: Effect<A, E, R>) => Effect<Fiber<A, E>, never, R | Scope> = internal.forkScoped

/**
 * Forks the effect into a new fiber attached to the global scope. Because the
 * new fiber is attached to the global scope, when the fiber executing the
 * returned effect terminates, the forked fiber will continue running.
 *
 * **Example** (Forking a detached fiber)
 *
 * ```ts
 * import { Effect } from "effect"
 *
 * const daemonTask = Effect.gen(function*() {
 *   while (true) {
 *     yield* Effect.sleep("1 second")
 *     yield* Effect.log("Daemon running...")
 *   }
 * })
 *
 * const program = Effect.gen(function*() {
 *   const fiber = yield* daemonTask.pipe(Effect.forkDetach)
 *
 *   // or fork a fiber that starts immediately:
 *   yield* daemonTask.pipe(Effect.forkDetach({ startImmediately: true }))
 *
 *   yield* Effect.log("Daemon started")
 *   yield* Effect.sleep("3 seconds")
 *   // Daemon continues running after this effect completes
 *   return "main completed"
 * })
 * ```
 *
 * @category supervision & fibers
 * @since 4.0.0
 */
export const forkDetach: <
  Arg extends Effect<any, any, any> | {
    readonly startImmediately?: boolean | undefined
    readonly uninterruptible?: boolean | "inherit" | undefined
  } | undefined = {
    readonly startImmediately?: boolean | undefined
    readonly uninterruptible?: boolean | "inherit" | undefined
  }
>(
  effectOrOptions?: Arg,
  options?: {
    readonly startImmediately?: boolean | undefined
    readonly uninterruptible?: boolean | "inherit" | undefined
  } | undefined
) => [Arg] extends [Effect<infer _A, infer _E, infer _R>] ? Effect<Fiber<_A, _E>, never, _R>
  : <A, E, R>(self: Effect<A, E, R>) => Effect<Fiber<A, E>, never, R> = internal.forkDetach

/**
 * Waits for all child fibers forked by this effect to complete before this
 * effect completes.
 *
 * **When to use**
 *
 * Use to let an effect start child work concurrently while still delaying its
 * own completion until that child work is done.
 *
 * **Gotchas**
 *
 * Child fibers that already exist before the wrapped effect starts are not
 * awaited.
 *
 * @see {@link forkChild} for forking child fibers that are awaited by this operator
 * @see {@link forkDetach} for forking fibers outside the child scope
 * @see {@link forkIn} for forking into an explicit scope
 * @see {@link forkScoped} for forking fibers tied to the current scope
 *
 * @category supervision & fibers
 * @since 2.0.0
 */
export const awaitAllChildren: <A, E, R>(self: Effect<A, E, R>) => Effect<A, E, R> = internal.awaitAllChildren

/**
 * Accesses the fiber currently executing the effect.
 *
 * **Example** (Accessing the current fiber)
 *
 * ```ts
 * import { Console, Effect } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const fiber = yield* Effect.fiber
 *   yield* Console.log(`Fiber id: ${fiber.id}`)
 * })
 * ```
 *
 * @category supervision & fibers
 * @since 4.0.0
 */
export const fiber: Effect<Fiber<unknown, unknown>> = internal.fiber

/**
 * Accesses the current fiber id executing the effect.
 *
 * **Example** (Accessing the current fiber id)
 *
 * ```ts
 * import { Effect } from "effect"
 *
 * const program = Effect.log("event").pipe(
 *   // Read the current span with the fiber id for tagging.
 *   Effect.andThen(Effect.all([Effect.currentSpan, Effect.fiberId])),
 *   Effect.withSpan("A"),
 *   Effect.map(([span, fiberId]) => ({
 *     spanName: span.name,
 *     fiberId
 *   }))
 * )
 * ```
 *
 * @category supervision & fibers
 * @since 2.0.0
 */
export const fiberId: Effect<number> = internal.fiberId

// -----------------------------------------------------------------------------
// Running Effects
// -----------------------------------------------------------------------------

/**
 * Configuration options for running Effect programs, providing control over
 * interruption and scheduling behavior.
 *
 * **When to use**
 *
 * Use to pass cancellation, scheduler, interruptibility, and fiber-start hooks
 * when running an `Effect` at a program boundary.
 *
 * **Details**
 *
 * `signal` interrupts the fiber, `scheduler` provides the scheduler service,
 * `uninterruptible` starts the fiber uninterruptibly, and `onFiberStart`
 * receives the created fiber.
 *
 * @see {@link runFork} for starting a fiber with these options
 * @see {@link runCallback} for callback-based running with these options
 * @see {@link runPromise} for promise-based running with these options
 * @see {@link runPromiseExit} for promise-based running that returns an `Exit`
 *
 * @category running effects
 * @since 4.0.0
 */
export interface RunOptions {
  readonly signal?: AbortSignal | undefined
  readonly scheduler?: Scheduler | undefined
  readonly uninterruptible?: boolean | undefined
  readonly onFiberStart?: ((fiber: Fiber<unknown, unknown>) => void) | undefined
}

/**
 * Runs an effect in the background, returning a fiber that can
 * be observed or interrupted.
 *
 * **When to use**
 *
 * Use when an effect should start in the background and return a fiber that can
 * be observed or interrupted. Prefer this when you do not need a `Promise` or
 * synchronous result.
 *
 * **Example** (Running an effect in the background)
 *
 * ```ts
 * import { Console, Effect, Fiber, Schedule } from "effect"
 *
 * //      ┌─── Effect<number, never, never>
 * //      ▼
 * const program = Effect.repeat(
 *   Console.log("running..."),
 *   Schedule.spaced("200 millis")
 * )
 *
 * //      ┌─── RuntimeFiber<number, never>
 * //      ▼
 * const fiber = Effect.runFork(program)
 *
 * setTimeout(() => {
 *   Effect.runFork(Fiber.interrupt(fiber))
 * }, 500)
 * ```
 *
 * @category running effects
 * @since 2.0.0
 */
export const runFork: <A, E>(effect: Effect<A, E, never>, options?: RunOptions | undefined) => Fiber<A, E> =
  internal.runFork

/**
 * Runs an effect in the background with the provided services.
 *
 * **Example** (Running with services in the background)
 *
 * ```ts
 * import { Context, Effect } from "effect"
 *
 * interface Logger {
 *   log: (message: string) => void
 * }
 *
 * const Logger = Context.Service<Logger>("Logger")
 *
 * const services = Context.make(Logger, {
 *   log: (message) => console.log(message)
 * })
 *
 * const program = Effect.gen(function*() {
 *   const logger = yield* Logger
 *   logger.log("Hello from service!")
 *   return "done"
 * })
 *
 * const fiber = Effect.runForkWith(services)(program)
 * ```
 *
 * @category running effects
 * @since 4.0.0
 */
export const runForkWith: <R>(
  context: Context.Context<R>
) => <A, E>(effect: Effect<A, E, R>, options?: RunOptions | undefined) => Fiber<A, E> = internal.runForkWith

/**
 * Forks an effect with the provided services, registers `onExit` as a fiber observer, and returns an interruptor.
 *
 * **Details**
 *
 * The returned interruptor calls `fiber.interruptUnsafe`, optionally with an interruptor id.
 *
 * **Example** (Running with services and a callback)
 *
 * ```ts
 * import { Console, Context, Effect, Exit } from "effect"
 *
 * interface Logger {
 *   log: (message: string) => Effect.Effect<void>
 * }
 *
 * const Logger = Context.Service<Logger>("Logger")
 *
 * const services = Context.make(Logger, {
 *   log: (message) => Console.log(message)
 * })
 *
 * const program = Effect.gen(function*() {
 *   const logger = yield* Logger
 *   yield* logger.log("Started")
 *   return "done"
 * })
 *
 * const interrupt = Effect.runCallbackWith(services)(program, {
 *   onExit: (exit) => {
 *     if (Exit.isFailure(exit)) {
 *       // handle failure or interruption
 *     }
 *   }
 * })
 *
 * // Use the interruptor if you need to cancel the fiber later.
 * interrupt()
 * ```
 *
 * @category running effects
 * @since 4.0.0
 */
export const runCallbackWith: <R>(
  context: Context.Context<R>
) => <A, E>(
  effect: Effect<A, E, R>,
  options?: (RunOptions & { readonly onExit: (exit: Exit.Exit<A, E>) => void }) | undefined
) => (interruptor?: number | undefined) => void = internal.runCallbackWith

/**
 * Runs an effect asynchronously, registering `onExit` as a fiber observer and
 * returning an interruptor.
 *
 * **Details**
 *
 * The interruptor calls `fiber.interruptUnsafe` with the optional interruptor
 * id.
 *
 * **Example** (Running with a callback)
 *
 * ```ts
 * import { Console, Effect, Exit } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   yield* Console.log("working")
 *   return "done"
 * })
 *
 * const interrupt = Effect.runCallback(program, {
 *   onExit: (exit) => {
 *     Effect.runSync(
 *       Exit.match(exit, {
 *         onFailure: () => Console.log("failed"),
 *         onSuccess: (value) => Console.log(`success: ${value}`)
 *       })
 *     )
 *   }
 * })
 *
 * // Output:
 * // working
 * // success: done
 *
 * // interrupt() to cancel the fiber if needed
 * ```
 *
 * @category running effects
 * @since 2.0.0
 */
export const runCallback: <A, E>(
  effect: Effect<A, E, never>,
  options?: (RunOptions & { readonly onExit: (exit: Exit.Exit<A, E>) => void }) | undefined
) => (interruptor?: number | undefined) => void = internal.runCallback

/**
 * Executes an effect and returns the result as a `Promise`.
 *
 * **When to use**
 *
 * Use when you need to execute an effect and work with the
 * result using `Promise` syntax, typically for compatibility with other
 * promise-based code.
 *
 * If the effect succeeds, the promise will resolve with the result. If the
 * effect fails, the promise will reject with an error.
 *
 * **Example** (Running a successful effect as a Promise)
 *
 * ```ts
 * import { Effect } from "effect"
 *
 * Effect.runPromise(Effect.succeed(1)).then(console.log)
 * // Output: 1
 * ```
 *
 * **Example** (Running effects as promises)
 *
 * ```ts
 * //Example: Handling a Failing Effect as a Rejected Promise
 * import { Effect } from "effect"
 *
 * Effect.runPromise(Effect.fail("my error")).catch(console.error)
 * // Output:
 * // (FiberFailure) Error: my error
 * ```
 *
 * @see {@link runPromiseExit} for a version that returns an `Exit` type instead of rejecting.
 * @category running effects
 * @since 2.0.0
 */
export const runPromise: <A, E>(
  effect: Effect<A, E>,
  options?: RunOptions | undefined
) => Promise<A> = internal.runPromise

/**
 * Executes an effect as a Promise with the provided services.
 *
 * **Example** (Running with services as a promise)
 *
 * ```ts
 * import { Context, Effect } from "effect"
 *
 * interface Config {
 *   apiUrl: string
 * }
 *
 * const Config = Context.Service<Config>("Config")
 *
 * const context = Context.make(Config, {
 *   apiUrl: "https://api.example.com"
 * })
 *
 * const program = Effect.gen(function*() {
 *   const config = yield* Config
 *   return `Connecting to ${config.apiUrl}`
 * })
 *
 * Effect.runPromiseWith(context)(program).then(console.log)
 * ```
 *
 * @category running effects
 * @since 4.0.0
 */
export const runPromiseWith: <R>(
  context: Context.Context<R>
) => <A, E>(effect: Effect<A, E, R>, options?: RunOptions | undefined) => Promise<A> = internal.runPromiseWith

/**
 * Runs an effect and returns a `Promise` that resolves to an `Exit`, which
 * represents the outcome (success or failure) of the effect.
 *
 * **When to use**
 *
 * Use when you need to determine if an effect succeeded
 * or failed, including any defects, and you want to work with a `Promise`.
 *
 * **Details**
 *
 * The `Exit` type represents the result of the effect:
 * - If the effect succeeds, the result is wrapped in a `Success`.
 * - If it fails, the failure information is provided as a `Failure` containing
 *   a `Cause` type.
 *
 * **Example** (Observing promise results as Exit)
 *
 * ```ts
 * import { Effect } from "effect"
 *
 * // Execute a successful effect and get the Exit result as a Promise
 * Effect.runPromiseExit(Effect.succeed(1)).then(console.log)
 * // Output:
 * // {
 * //   _id: "Exit",
 * //   _tag: "Success",
 * //   value: 1
 * // }
 *
 * // Execute a failing effect and get the Exit result as a Promise
 * Effect.runPromiseExit(Effect.fail("my error")).then(console.log)
 * // Output:
 * // {
 * //   _id: "Exit",
 * //   _tag: "Failure",
 * //   cause: {
 * //     _id: "Cause",
 * //     _tag: "Fail",
 * //     failure: "my error"
 * //   }
 * // }
 * ```
 *
 * @see {@link runPromise} for a version that rejects on failure.
 *
 * @category running effects
 * @since 2.0.0
 */
export const runPromiseExit: <A, E>(
  effect: Effect<A, E>,
  options?: RunOptions | undefined
) => Promise<Exit.Exit<A, E>> = internal.runPromiseExit

/**
 * Runs an effect and returns a Promise of Exit with provided services.
 *
 * **Example** (Running with services as an Exit promise)
 *
 * ```ts
 * import { Context, Effect, Exit } from "effect"
 *
 * interface Database {
 *   query: (sql: string) => string
 * }
 *
 * const Database = Context.Service<Database>("Database")
 *
 * const services = Context.make(Database, {
 *   query: (sql) => `Result for: ${sql}`
 * })
 *
 * const program = Effect.gen(function*() {
 *   const db = yield* Database
 *   return db.query("SELECT * FROM users")
 * })
 *
 * Effect.runPromiseExitWith(services)(program).then((exit) => {
 *   if (Exit.isSuccess(exit)) {
 *     console.log("Success:", exit.value)
 *   }
 * })
 * ```
 *
 * @category running effects
 * @since 4.0.0
 */
export const runPromiseExitWith: <R>(
  context: Context.Context<R>
) => <A, E>(effect: Effect<A, E, R>, options?: RunOptions | undefined) => Promise<Exit.Exit<A, E>> =
  internal.runPromiseExitWith

/**
 * Executes an effect synchronously and returns its success value.
 *
 * **When to use**
 *
 * Use when you need to execute an effect that is guaranteed to complete
 * synchronously.
 *
 * **Details**
 *
 * If the effect fails, dies, is interrupted, or performs asynchronous work,
 * `runSync` throws a `FiberFailure` instead of returning a value. Use
 * `runSyncExit` when you want the failure captured as an `Exit`.
 *
 * **Example** (Running a synchronous effect)
 *
 * ```ts
 * import { Effect } from "effect"
 *
 * const program = Effect.sync(() => {
 *   console.log("Hello, World!")
 *   return 1
 * })
 *
 * const result = Effect.runSync(program)
 * // Output: Hello, World!
 *
 * console.log(result)
 * // Output: 1
 * ```
 *
 * **Example** (Throwing for failed or async effects)
 *
 * ```ts
 * import { Effect } from "effect"
 *
 * try {
 *   // Attempt to run an effect that fails
 *   Effect.runSync(Effect.fail("my error"))
 * } catch (e) {
 *   console.error(e)
 * }
 * // Output:
 * // (FiberFailure) Error: my error
 *
 * try {
 *   // Attempt to run an effect that involves async work
 *   Effect.runSync(Effect.promise(() => Promise.resolve(1)))
 * } catch (e) {
 *   console.error(e)
 * }
 * // Output:
 * // (FiberFailure) AsyncFiberException: Fiber #0 cannot be resolved synchronously. This is caused by using runSync on an effect that performs async work
 * ```
 *
 * @see {@link runSyncExit} for a version that returns an `Exit` type instead of
 * throwing an error.
 * @category running effects
 * @since 2.0.0
 */
export const runSync: <A, E>(effect: Effect<A, E>) => A = internal.runSync

/**
 * Executes an effect synchronously with provided services.
 *
 * **Example** (Running synchronously with services)
 *
 * ```ts
 * import { Context, Effect } from "effect"
 *
 * interface MathService {
 *   add: (a: number, b: number) => number
 * }
 *
 * const MathService = Context.Service<MathService>("MathService")
 *
 * const context = Context.make(MathService, {
 *   add: (a, b) => a + b
 * })
 *
 * const program = Effect.gen(function*() {
 *   const math = yield* MathService
 *   return math.add(2, 3)
 * })
 *
 * const result = Effect.runSyncWith(context)(program)
 * console.log(result) // 5
 * ```
 *
 * @category running effects
 * @since 4.0.0
 */
export const runSyncWith: <R>(
  context: Context.Context<R>
) => <A, E>(effect: Effect<A, E, R>) => A = internal.runSyncWith

/**
 * Runs an effect synchronously and captures the outcome safely as an `Exit` type, which
 * represents the outcome (success or failure) of the effect.
 *
 * **When to use**
 *
 * Use to find out whether an effect succeeded or failed,
 * including any defects, without dealing with asynchronous operations.
 *
 * **Details**
 *
 * The `Exit` type represents the result of the effect:
 * - If the effect succeeds, the result is wrapped in a `Success`.
 * - If it fails, the failure information is provided as a `Failure` containing
 *   a `Cause` type.
 *
 * If the effect contains asynchronous operations, `runSyncExit` will
 * return an `Failure` with a `Die` cause, indicating that the effect cannot be
 * resolved synchronously.
 *
 * **Example** (Observing synchronous results as Exit)
 *
 * ```ts
 * import { Effect } from "effect"
 *
 * console.log(Effect.runSyncExit(Effect.succeed(1)))
 * // Output:
 * // {
 * //   _id: "Exit",
 * //   _tag: "Success",
 * //   value: 1
 * // }
 *
 * console.log(Effect.runSyncExit(Effect.fail("my error")))
 * // Output:
 * // {
 * //   _id: "Exit",
 * //   _tag: "Failure",
 * //   cause: {
 * //     _id: "Cause",
 * //     _tag: "Fail",
 * //     failure: "my error"
 * //   }
 * // }
 * ```
 *
 * **Example** (Capturing async work as a Die cause)
 *
 * ```ts
 * import { Effect } from "effect"
 *
 * console.log(Effect.runSyncExit(Effect.promise(() => Promise.resolve(1))))
 * // Output:
 * // {
 * //   _id: 'Exit',
 * //   _tag: 'Failure',
 * //   cause: {
 * //     _id: 'Cause',
 * //     _tag: 'Die',
 * //     defect: [Fiber #0 cannot be resolved synchronously. This is caused by using runSync on an effect that performs async work] {
 * //       fiber: [FiberRuntime],
 * //       _tag: 'AsyncFiberException',
 * //       name: 'AsyncFiberException'
 * //     }
 * //   }
 * // }
 * ```
 *
 * @see {@link runSync} for a version that throws on failure.
 *
 * @category running effects
 * @since 2.0.0
 */
export const runSyncExit: <A, E>(effect: Effect<A, E>) => Exit.Exit<A, E> = internal.runSyncExit

/**
 * Runs an effect synchronously with provided services, returning an Exit result safely.
 *
 * **Example** (Running synchronously with services as Exit)
 *
 * ```ts
 * import { Context, Effect, Exit } from "effect"
 *
 * // Define a logger service
 * const Logger = Context.Service<{
 *   log: (msg: string) => void
 * }>("Logger")
 *
 * const program = Effect.gen(function*() {
 *   const logger = yield* Effect.service(Logger)
 *   logger.log("Computing result...")
 *   return 42
 * })
 *
 * // Prepare context
 * const context = Context.make(Logger, {
 *   log: (msg) => console.log(`[LOG] ${msg}`)
 * })
 *
 * const exit = Effect.runSyncExitWith(context)(program)
 *
 * if (Exit.isSuccess(exit)) {
 *   console.log(`Success: ${exit.value}`)
 * } else {
 *   console.log(`Failure: ${exit.cause}`)
 * }
 * // Output:
 * // [LOG] Computing result...
 * // Success: 42
 * ```
 *
 * @category running effects
 * @since 4.0.0
 */
export const runSyncExitWith: <R>(
  context: Context.Context<R>
) => <A, E>(effect: Effect<A, E, R>) => Exit.Exit<A, E> = internal.runSyncExitWith

// -----------------------------------------------------------------------------
// Function
// -----------------------------------------------------------------------------

/**
 * Type helpers for functions built with `Effect.fn` and `Effect.fnUntraced`.
 *
 * **Details**
 *
 * Use these to describe generator-based signatures and traced or untraced variants.
 *
 * @since 3.11.0
 */
export declare namespace fn {
  /**
   * Generator return type accepted by `Effect.fn` and `Effect.fnUntraced`.
   *
   * @category models
   * @since 3.19.0
   */
  export type Return<A, E = never, R = never> = Generator<Effect<any, E, R>, A, any>

  /**
   * Type of the untraced function builder used by `Effect.fnUntraced`.
   *
   * @category models
   * @since 3.11.0
   */
  export type Untraced = {
    <Eff extends Effect<any, any, any>, AEff, Args extends Array<any>>(
      body: (this: unassigned, ...args: Args) => Generator<Eff, AEff, never>
    ): (...args: Args) => Effect<
      AEff,
      [Eff] extends [never] ? never
        : [Eff] extends [Effect<infer _A, infer E, infer _R>] ? E
        : never,
      [Eff] extends [never] ? never
        : [Eff] extends [Effect<infer _A, infer _E, infer R>] ? R
        : never
    >
    <Self, Eff extends Effect<any, any, any>, AEff, Args extends Array<any>>(
      body: (this: Self, ...args: Args) => Generator<Eff, AEff, never>
    ): (this: Self, ...args: Args) => Effect<
      AEff,
      [Eff] extends [never] ? never
        : [Eff] extends [Effect<infer _A, infer E, infer _R>] ? E
        : never,
      [Eff] extends [never] ? never
        : [Eff] extends [Effect<infer _A, infer _E, infer R>] ? R
        : never
    >

    <Eff extends Effect<any, any, any>, AEff, Args extends Array<any>, A>(
      body: (this: unassigned, ...args: Args) => Generator<Eff, AEff, never>,
      a: (
        _: Effect<
          AEff,
          [Eff] extends [never] ? never
            : [Eff] extends [Effect<infer _A, infer E, infer _R>] ? E
            : never,
          [Eff] extends [never] ? never
            : [Eff] extends [Effect<infer _A, infer _E, infer R>] ? R
            : never
        >,
        ...args: Args
      ) => A
    ): (...args: Args) => A
    <Self, Eff extends Effect<any, any, any>, AEff, Args extends Array<any>, A>(
      body: (this: Self, ...args: Args) => Generator<Eff, AEff, never>,
      a: (
        _: Effect<
          AEff,
          [Eff] extends [never] ? never
            : [Eff] extends [Effect<infer _A, infer E, infer _R>] ? E
            : never,
          [Eff] extends [never] ? never
            : [Eff] extends [Effect<infer _A, infer _E, infer R>] ? R
            : never
        >,
        ...args: Args
      ) => A
    ): (this: Self, ...args: Args) => A
    <Eff extends Effect<any, any, any>, AEff, Args extends Array<any>, A, B>(
      body: (this: unassigned, ...args: Args) => Generator<Eff, AEff, never>,
      a: (
        _: Effect<
          AEff,
          [Eff] extends [never] ? never
            : [Eff] extends [Effect<infer _A, infer E, infer _R>] ? E
            : never,
          [Eff] extends [never] ? never
            : [Eff] extends [Effect<infer _A, infer _E, infer R>] ? R
            : never
        >,
        ...args: Args
      ) => A,
      b: (_: A, ...args: Args) => B
    ): (...args: Args) => B
    <Self, Eff extends Effect<any, any, any>, AEff, Args extends Array<any>, A, B>(
      body: (this: Self, ...args: Args) => Generator<Eff, AEff, never>,
      a: (
        _: Effect<
          AEff,
          [Eff] extends [never] ? never
            : [Eff] extends [Effect<infer _A, infer E, infer _R>] ? E
            : never,
          [Eff] extends [never] ? never
            : [Eff] extends [Effect<infer _A, infer _E, infer R>] ? R
            : never
        >,
        ...args: Args
      ) => A,
      b: (_: A, ...args: Args) => B
    ): (this: Self, ...args: Args) => B
    <
      Eff extends Effect<any, any, any>,
      AEff,
      Args extends Array<any>,
      A,
      B,
      C
    >(
      body: (this: unassigned, ...args: Args) => Generator<Eff, AEff, never>,
      a: (
        _: Effect<
          AEff,
          [Eff] extends [never] ? never
            : [Eff] extends [Effect<infer _A, infer E, infer _R>] ? E
            : never,
          [Eff] extends [never] ? never
            : [Eff] extends [Effect<infer _A, infer _E, infer R>] ? R
            : never
        >,
        ...args: Args
      ) => A,
      b: (_: A, ...args: Args) => B,
      c: (_: B, ...args: Args) => C
    ): (...args: Args) => C
    <
      Self,
      Eff extends Effect<any, any, any>,
      AEff,
      Args extends Array<any>,
      A,
      B,
      C
    >(
      body: (this: Self, ...args: Args) => Generator<Eff, AEff, never>,
      a: (
        _: Effect<
          AEff,
          [Eff] extends [never] ? never
            : [Eff] extends [Effect<infer _A, infer E, infer _R>] ? E
            : never,
          [Eff] extends [never] ? never
            : [Eff] extends [Effect<infer _A, infer _E, infer R>] ? R
            : never
        >,
        ...args: Args
      ) => A,
      b: (_: A, ...args: Args) => B,
      c: (_: B, ...args: Args) => C
    ): (this: Self, ...args: Args) => C
    <
      Eff extends Effect<any, any, any>,
      AEff,
      Args extends Array<any>,
      A,
      B,
      C,
      D
    >(
      body: (...args: Args) => Generator<Eff, AEff, never>,
      a: (
        _: Effect<
          AEff,
          [Eff] extends [never] ? never
            : [Eff] extends [Effect<infer _A, infer E, infer _R>] ? E
            : never,
          [Eff] extends [never] ? never
            : [Eff] extends [Effect<infer _A, infer _E, infer R>] ? R
            : never
        >,
        ...args: Args
      ) => A,
      b: (_: A, ...args: Args) => B,
      c: (_: B, ...args: Args) => C,
      d: (_: C, ...args: Args) => D
    ): (...args: Args) => D
    <
      Self,
      Eff extends Effect<any, any, any>,
      AEff,
      Args extends Array<any>,
      A,
      B,
      C,
      D
    >(
      body: (this: Self, ...args: Args) => Generator<Eff, AEff, never>,
      a: (
        _: Effect<
          AEff,
          [Eff] extends [never] ? never
            : [Eff] extends [Effect<infer _A, infer E, infer _R>] ? E
            : never,
          [Eff] extends [never] ? never
            : [Eff] extends [Effect<infer _A, infer _E, infer R>] ? R
            : never
        >,
        ...args: Args
      ) => A,
      b: (_: A, ...args: Args) => B,
      c: (_: B, ...args: Args) => C,
      d: (_: C, ...args: Args) => D
    ): (this: Self, ...args: Args) => D
    <
      Eff extends Effect<any, any, any>,
      AEff,
      Args extends Array<any>,
      A,
      B,
      C,
      D,
      E
    >(
      body: (this: unassigned, ...args: Args) => Generator<Eff, AEff, never>,
      a: (
        _: Effect<
          AEff,
          [Eff] extends [never] ? never
            : [Eff] extends [Effect<infer _A, infer E, infer _R>] ? E
            : never,
          [Eff] extends [never] ? never
            : [Eff] extends [Effect<infer _A, infer _E, infer R>] ? R
            : never
        >,
        ...args: Args
      ) => A,
      b: (_: A, ...args: Args) => B,
      c: (_: B, ...args: Args) => C,
      d: (_: C, ...args: Args) => D,
      e: (_: D, ...args: Args) => E
    ): (...args: Args) => E
    <
      Self,
      Eff extends Effect<any, any, any>,
      AEff,
      Args extends Array<any>,
      A,
      B,
      C,
      D,
      E
    >(
      body: (this: Self, ...args: Args) => Generator<Eff, AEff, never>,
      a: (
        _: Effect<
          AEff,
          [Eff] extends [never] ? never
            : [Eff] extends [Effect<infer _A, infer E, infer _R>] ? E
            : never,
          [Eff] extends [never] ? never
            : [Eff] extends [Effect<infer _A, infer _E, infer R>] ? R
            : never
        >,
        ...args: Args
      ) => A,
      b: (_: A, ...args: Args) => B,
      c: (_: B, ...args: Args) => C,
      d: (_: C, ...args: Args) => D,
      e: (_: D, ...args: Args) => E
    ): (this: Self, ...args: Args) => E
    <
      Eff extends Effect<any, any, any>,
      AEff,
      Args extends Array<any>,
      A,
      B,
      C,
      D,
      E,
      F
    >(
      body: (this: unassigned, ...args: Args) => Generator<Eff, AEff, never>,
      a: (
        _: Effect<
          AEff,
          [Eff] extends [never] ? never
            : [Eff] extends [Effect<infer _A, infer E, infer _R>] ? E
            : never,
          [Eff] extends [never] ? never
            : [Eff] extends [Effect<infer _A, infer _E, infer R>] ? R
            : never
        >,
        ...args: Args
      ) => A,
      b: (_: A, ...args: Args) => B,
      c: (_: B, ...args: Args) => C,
      d: (_: C, ...args: Args) => D,
      e: (_: D, ...args: Args) => E,
      f: (_: E, ...args: Args) => F
    ): (...args: Args) => F
    <
      Self,
      Eff extends Effect<any, any, any>,
      AEff,
      Args extends Array<any>,
      A,
      B,
      C,
      D,
      E,
      F
    >(
      body: (this: Self, ...args: Args) => Generator<Eff, AEff, never>,
      a: (
        _: Effect<
          AEff,
          [Eff] extends [never] ? never
            : [Eff] extends [Effect<infer _A, infer E, infer _R>] ? E
            : never,
          [Eff] extends [never] ? never
            : [Eff] extends [Effect<infer _A, infer _E, infer R>] ? R
            : never
        >,
        ...args: Args
      ) => A,
      b: (_: A, ...args: Args) => B,
      c: (_: B, ...args: Args) => C,
      d: (_: C, ...args: Args) => D,
      e: (_: D, ...args: Args) => E,
      f: (_: E, ...args: Args) => F
    ): (this: Self, ...args: Args) => F
    <
      Eff extends Effect<any, any, any>,
      AEff,
      Args extends Array<any>,
      A,
      B,
      C,
      D,
      E,
      F,
      G
    >(
      body: (this: unassigned, ...args: Args) => Generator<Eff, AEff, never>,
      a: (
        _: Effect<
          AEff,
          [Eff] extends [never] ? never
            : [Eff] extends [Effect<infer _A, infer E, infer _R>] ? E
            : never,
          [Eff] extends [never] ? never
            : [Eff] extends [Effect<infer _A, infer _E, infer R>] ? R
            : never
        >,
        ...args: Args
      ) => A,
      b: (_: A, ...args: Args) => B,
      c: (_: B, ...args: Args) => C,
      d: (_: C, ...args: Args) => D,
      e: (_: D, ...args: Args) => E,
      f: (_: E, ...args: Args) => F,
      g: (_: F, ...args: Args) => G
    ): (...args: Args) => G
    <
      Self,
      Eff extends Effect<any, any, any>,
      AEff,
      Args extends Array<any>,
      A,
      B,
      C,
      D,
      E,
      F,
      G
    >(
      body: (this: Self, ...args: Args) => Generator<Eff, AEff, never>,
      a: (
        _: Effect<
          AEff,
          [Eff] extends [never] ? never
            : [Eff] extends [Effect<infer _A, infer E, infer _R>] ? E
            : never,
          [Eff] extends [never] ? never
            : [Eff] extends [Effect<infer _A, infer _E, infer R>] ? R
            : never
        >,
        ...args: Args
      ) => A,
      b: (_: A, ...args: Args) => B,
      c: (_: B, ...args: Args) => C,
      d: (_: C, ...args: Args) => D,
      e: (_: D, ...args: Args) => E,
      f: (_: E, ...args: Args) => F,
      g: (_: F, ...args: Args) => G
    ): (this: Self, ...args: Args) => G
    <
      Eff extends Effect<any, any, any>,
      AEff,
      Args extends Array<any>,
      A,
      B,
      C,
      D,
      E,
      F,
      G,
      H
    >(
      body: (this: unassigned, ...args: Args) => Generator<Eff, AEff, never>,
      a: (
        _: Effect<
          AEff,
          [Eff] extends [never] ? never
            : [Eff] extends [Effect<infer _A, infer E, infer _R>] ? E
            : never,
          [Eff] extends [never] ? never
            : [Eff] extends [Effect<infer _A, infer _E, infer R>] ? R
            : never
        >,
        ...args: Args
      ) => A,
      b: (_: A, ...args: Args) => B,
      c: (_: B, ...args: Args) => C,
      d: (_: C, ...args: Args) => D,
      e: (_: D, ...args: Args) => E,
      f: (_: E, ...args: Args) => F,
      g: (_: F, ...args: Args) => G,
      h: (_: G, ...args: Args) => H
    ): (...args: Args) => H
    <
      Self,
      Eff extends Effect<any, any, any>,
      AEff,
      Args extends Array<any>,
      A,
      B,
      C,
      D,
      E,
      F,
      G,
      H
    >(
      body: (this: Self, ...args: Args) => Generator<Eff, AEff, never>,
      a: (
        _: Effect<
          AEff,
          [Eff] extends [never] ? never
            : [Eff] extends [Effect<infer _A, infer E, infer _R>] ? E
            : never,
          [Eff] extends [never] ? never
            : [Eff] extends [Effect<infer _A, infer _E, infer R>] ? R
            : never
        >,
        ...args: Args
      ) => A,
      b: (_: A, ...args: Args) => B,
      c: (_: B, ...args: Args) => C,
      d: (_: C, ...args: Args) => D,
      e: (_: D, ...args: Args) => E,
      f: (_: E, ...args: Args) => F,
      g: (_: F, ...args: Args) => G,
      h: (_: G, ...args: Args) => H
    ): (this: Self, ...args: Args) => H
    <
      Eff extends Effect<any, any, any>,
      AEff,
      Args extends Array<any>,
      A,
      B,
      C,
      D,
      E,
      F,
      G,
      H,
      I
    >(
      body: (this: unassigned, ...args: Args) => Generator<Eff, AEff, never>,
      a: (
        _: Effect<
          AEff,
          [Eff] extends [never] ? never
            : [Eff] extends [Effect<infer _A, infer E, infer _R>] ? E
            : never,
          [Eff] extends [never] ? never
            : [Eff] extends [Effect<infer _A, infer _E, infer R>] ? R
            : never
        >,
        ...args: Args
      ) => A,
      b: (_: A, ...args: Args) => B,
      c: (_: B, ...args: Args) => C,
      d: (_: C, ...args: Args) => D,
      e: (_: D, ...args: Args) => E,
      f: (_: E, ...args: Args) => F,
      g: (_: F, ...args: Args) => G,
      h: (_: G, ...args: Args) => H,
      i: (_: H, ...args: Args) => I
    ): (...args: Args) => I
    <
      Self,
      Eff extends Effect<any, any, any>,
      AEff,
      Args extends Array<any>,
      A,
      B,
      C,
      D,
      E,
      F,
      G,
      H,
      I
    >(
      body: (this: Self, ...args: Args) => Generator<Eff, AEff, never>,
      a: (
        _: Effect<
          AEff,
          [Eff] extends [never] ? never
            : [Eff] extends [Effect<infer _A, infer E, infer _R>] ? E
            : never,
          [Eff] extends [never] ? never
            : [Eff] extends [Effect<infer _A, infer _E, infer R>] ? R
            : never
        >,
        ...args: Args
      ) => A,
      b: (_: A, ...args: Args) => B,
      c: (_: B, ...args: Args) => C,
      d: (_: C, ...args: Args) => D,
      e: (_: D, ...args: Args) => E,
      f: (_: E, ...args: Args) => F,
      g: (_: F, ...args: Args) => G,
      h: (_: G, ...args: Args) => H,
      i: (_: H, ...args: Args) => I
    ): (this: Self, ...args: Args) => I
    <
      Eff extends Effect<any, any, any>,
      AEff,
      Args extends Array<any>,
      A,
      B,
      C,
      D,
      E,
      F,
      G,
      H,
      I,
      J
    >(
      body: (this: unassigned, ...args: Args) => Generator<Eff, AEff, never>,
      a: (
        _: Effect<
          AEff,
          [Eff] extends [never] ? never
            : [Eff] extends [Effect<infer _A, infer E, infer _R>] ? E
            : never,
          [Eff] extends [never] ? never
            : [Eff] extends [Effect<infer _A, infer _E, infer R>] ? R
            : never
        >,
        ...args: Args
      ) => A,
      b: (_: A, ...args: Args) => B,
      c: (_: B, ...args: Args) => C,
      d: (_: C, ...args: Args) => D,
      e: (_: D, ...args: Args) => E,
      f: (_: E, ...args: Args) => F,
      g: (_: F, ...args: Args) => G,
      h: (_: G, ...args: Args) => H,
      i: (_: H, ...args: Args) => I,
      j: (_: I, ...args: Args) => J
    ): (...args: Args) => J
    <
      Self,
      Eff extends Effect<any, any, any>,
      AEff,
      Args extends Array<any>,
      A,
      B,
      C,
      D,
      E,
      F,
      G,
      H,
      I,
      J
    >(
      body: (this: Self, ...args: Args) => Generator<Eff, AEff, never>,
      a: (
        _: Effect<
          AEff,
          [Eff] extends [never] ? never
            : [Eff] extends [Effect<infer _A, infer E, infer _R>] ? E
            : never,
          [Eff] extends [never] ? never
            : [Eff] extends [Effect<infer _A, infer _E, infer R>] ? R
            : never
        >,
        ...args: Args
      ) => A,
      b: (_: A, ...args: Args) => B,
      c: (_: B, ...args: Args) => C,
      d: (_: C, ...args: Args) => D,
      e: (_: D, ...args: Args) => E,
      f: (_: E, ...args: Args) => F,
      g: (_: F, ...args: Args) => G,
      h: (_: G, ...args: Args) => H,
      i: (_: H, ...args: Args) => I,
      j: (_: I, ...args: Args) => J
    ): (this: Self, ...args: Args) => J
    <
      Eff extends Effect<any, any, any>,
      AEff,
      Args extends Array<any>,
      A,
      B,
      C,
      D,
      E,
      F,
      G,
      H,
      I,
      J,
      K
    >(
      body: (this: unassigned, ...args: Args) => Generator<Eff, AEff, never>,
      a: (
        _: Effect<
          AEff,
          [Eff] extends [never] ? never
            : [Eff] extends [Effect<infer _A, infer E, infer _R>] ? E
            : never,
          [Eff] extends [never] ? never
            : [Eff] extends [Effect<infer _A, infer _E, infer R>] ? R
            : never
        >,
        ...args: Args
      ) => A,
      b: (_: A, ...args: Args) => B,
      c: (_: B, ...args: Args) => C,
      d: (_: C, ...args: Args) => D,
      e: (_: D, ...args: Args) => E,
      f: (_: E, ...args: Args) => F,
      g: (_: F, ...args: Args) => G,
      h: (_: G, ...args: Args) => H,
      i: (_: H, ...args: Args) => I,
      j: (_: I, ...args: Args) => J,
      k: (_: J, ...args: Args) => K
    ): (...args: Args) => K
    <
      Self,
      Eff extends Effect<any, any, any>,
      AEff,
      Args extends Array<any>,
      A,
      B,
      C,
      D,
      E,
      F,
      G,
      H,
      I,
      J,
      K
    >(
      body: (this: Self, ...args: Args) => Generator<Eff, AEff, never>,
      a: (
        _: Effect<
          AEff,
          [Eff] extends [never] ? never
            : [Eff] extends [Effect<infer _A, infer E, infer _R>] ? E
            : never,
          [Eff] extends [never] ? never
            : [Eff] extends [Effect<infer _A, infer _E, infer R>] ? R
            : never
        >,
        ...args: Args
      ) => A,
      b: (_: A, ...args: Args) => B,
      c: (_: B, ...args: Args) => C,
      d: (_: C, ...args: Args) => D,
      e: (_: D, ...args: Args) => E,
      f: (_: E, ...args: Args) => F,
      g: (_: F, ...args: Args) => G,
      h: (_: G, ...args: Args) => H,
      i: (_: H, ...args: Args) => I,
      j: (_: I, ...args: Args) => J,
      k: (_: J, ...args: Args) => K
    ): (this: Self, ...args: Args) => K
    <
      Eff extends Effect<any, any, any>,
      AEff,
      Args extends Array<any>,
      A,
      B,
      C,
      D,
      E,
      F,
      G,
      H,
      I,
      J,
      K,
      L
    >(
      body: (this: unassigned, ...args: Args) => Generator<Eff, AEff, never>,
      a: (
        _: Effect<
          AEff,
          [Eff] extends [never] ? never
            : [Eff] extends [Effect<infer _A, infer E, infer _R>] ? E
            : never,
          [Eff] extends [never] ? never
            : [Eff] extends [Effect<infer _A, infer _E, infer R>] ? R
            : never
        >,
        ...args: Args
      ) => A,
      b: (_: A, ...args: Args) => B,
      c: (_: B, ...args: Args) => C,
      d: (_: C, ...args: Args) => D,
      e: (_: D, ...args: Args) => E,
      f: (_: E, ...args: Args) => F,
      g: (_: F, ...args: Args) => G,
      h: (_: G, ...args: Args) => H,
      i: (_: H, ...args: Args) => I,
      j: (_: I, ...args: Args) => J,
      k: (_: J, ...args: Args) => K,
      l: (_: K, ...args: Args) => L
    ): (...args: Args) => L
    <
      Self,
      Eff extends Effect<any, any, any>,
      AEff,
      Args extends Array<any>,
      A,
      B,
      C,
      D,
      E,
      F,
      G,
      H,
      I,
      J,
      K,
      L
    >(
      body: (this: Self, ...args: Args) => Generator<Eff, AEff, never>,
      a: (
        _: Effect<
          AEff,
          [Eff] extends [never] ? never
            : [Eff] extends [Effect<infer _A, infer E, infer _R>] ? E
            : never,
          [Eff] extends [never] ? never
            : [Eff] extends [Effect<infer _A, infer _E, infer R>] ? R
            : never
        >,
        ...args: Args
      ) => A,
      b: (_: A, ...args: Args) => B,
      c: (_: B, ...args: Args) => C,
      d: (_: C, ...args: Args) => D,
      e: (_: D, ...args: Args) => E,
      f: (_: E, ...args: Args) => F,
      g: (_: F, ...args: Args) => G,
      h: (_: G, ...args: Args) => H,
      i: (_: H, ...args: Args) => I,
      j: (_: I, ...args: Args) => J,
      k: (_: J, ...args: Args) => K,
      l: (_: K, ...args: Args) => L
    ): (this: Self, ...args: Args) => L
    <
      Eff extends Effect<any, any, any>,
      AEff,
      Args extends Array<any>,
      A,
      B,
      C,
      D,
      E,
      F,
      G,
      H,
      I,
      J,
      K,
      L,
      M
    >(
      body: (this: unassigned, ...args: Args) => Generator<Eff, AEff, never>,
      a: (
        _: Effect<
          AEff,
          [Eff] extends [never] ? never
            : [Eff] extends [Effect<infer _A, infer E, infer _R>] ? E
            : never,
          [Eff] extends [never] ? never
            : [Eff] extends [Effect<infer _A, infer _E, infer R>] ? R
            : never
        >,
        ...args: Args
      ) => A,
      b: (_: A, ...args: Args) => B,
      c: (_: B, ...args: Args) => C,
      d: (_: C, ...args: Args) => D,
      e: (_: D, ...args: Args) => E,
      f: (_: E, ...args: Args) => F,
      g: (_: F, ...args: Args) => G,
      h: (_: G, ...args: Args) => H,
      i: (_: H, ...args: Args) => I,
      j: (_: I, ...args: Args) => J,
      k: (_: J, ...args: Args) => K,
      l: (_: K, ...args: Args) => L,
      m: (_: L, ...args: Args) => M
    ): (...args: Args) => M
    <
      Self,
      Eff extends Effect<any, any, any>,
      AEff,
      Args extends Array<any>,
      A,
      B,
      C,
      D,
      E,
      F,
      G,
      H,
      I,
      J,
      K,
      L,
      M
    >(
      body: (this: Self, ...args: Args) => Generator<Eff, AEff, never>,
      a: (
        _: Effect<
          AEff,
          [Eff] extends [never] ? never
            : [Eff] extends [Effect<infer _A, infer E, infer _R>] ? E
            : never,
          [Eff] extends [never] ? never
            : [Eff] extends [Effect<infer _A, infer _E, infer R>] ? R
            : never
        >,
        ...args: Args
      ) => A,
      b: (_: A, ...args: Args) => B,
      c: (_: B, ...args: Args) => C,
      d: (_: C, ...args: Args) => D,
      e: (_: D, ...args: Args) => E,
      f: (_: E, ...args: Args) => F,
      g: (_: F, ...args: Args) => G,
      h: (_: G, ...args: Args) => H,
      i: (_: H, ...args: Args) => I,
      j: (_: I, ...args: Args) => J,
      k: (_: J, ...args: Args) => K,
      l: (_: K, ...args: Args) => L,
      m: (_: L, ...args: Args) => M
    ): (this: Self, ...args: Args) => M
    <
      Eff extends Effect<any, any, any>,
      AEff,
      Args extends Array<any>,
      A,
      B,
      C,
      D,
      E,
      F,
      G,
      H,
      I,
      J,
      K,
      L,
      M,
      N
    >(
      body: (this: unassigned, ...args: Args) => Generator<Eff, AEff, never>,
      a: (
        _: Effect<
          AEff,
          [Eff] extends [never] ? never
            : [Eff] extends [Effect<infer _A, infer E, infer _R>] ? E
            : never,
          [Eff] extends [never] ? never
            : [Eff] extends [Effect<infer _A, infer _E, infer R>] ? R
            : never
        >,
        ...args: Args
      ) => A,
      b: (_: A, ...args: Args) => B,
      c: (_: B, ...args: Args) => C,
      d: (_: C, ...args: Args) => D,
      e: (_: D, ...args: Args) => E,
      f: (_: E, ...args: Args) => F,
      g: (_: F, ...args: Args) => G,
      h: (_: G, ...args: Args) => H,
      i: (_: H, ...args: Args) => I,
      j: (_: I, ...args: Args) => J,
      k: (_: J, ...args: Args) => K,
      l: (_: K, ...args: Args) => L,
      m: (_: L, ...args: Args) => M,
      n: (_: M, ...args: Args) => N
    ): (...args: Args) => N
    <
      Self,
      Eff extends Effect<any, any, any>,
      AEff,
      Args extends Array<any>,
      A,
      B,
      C,
      D,
      E,
      F,
      G,
      H,
      I,
      J,
      K,
      L,
      M,
      N
    >(
      body: (this: Self, ...args: Args) => Generator<Eff, AEff, never>,
      a: (
        _: Effect<
          AEff,
          [Eff] extends [never] ? never
            : [Eff] extends [Effect<infer _A, infer E, infer _R>] ? E
            : never,
          [Eff] extends [never] ? never
            : [Eff] extends [Effect<infer _A, infer _E, infer R>] ? R
            : never
        >,
        ...args: Args
      ) => A,
      b: (_: A, ...args: Args) => B,
      c: (_: B, ...args: Args) => C,
      d: (_: C, ...args: Args) => D,
      e: (_: D, ...args: Args) => E,
      f: (_: E, ...args: Args) => F,
      g: (_: F, ...args: Args) => G,
      h: (_: G, ...args: Args) => H,
      i: (_: H, ...args: Args) => I,
      j: (_: I, ...args: Args) => J,
      k: (_: J, ...args: Args) => K,
      l: (_: K, ...args: Args) => L,
      m: (_: L, ...args: Args) => M,
      n: (_: M, ...args: Args) => N
    ): (this: Self, ...args: Args) => N
    <
      Eff extends Effect<any, any, any>,
      AEff,
      Args extends Array<any>,
      A,
      B,
      C,
      D,
      E,
      F,
      G,
      H,
      I,
      J,
      K,
      L,
      M,
      N,
      O
    >(
      body: (this: unassigned, ...args: Args) => Generator<Eff, AEff, never>,
      a: (
        _: Effect<
          AEff,
          [Eff] extends [never] ? never
            : [Eff] extends [Effect<infer _A, infer E, infer _R>] ? E
            : never,
          [Eff] extends [never] ? never
            : [Eff] extends [Effect<infer _A, infer _E, infer R>] ? R
            : never
        >,
        ...args: Args
      ) => A,
      b: (_: A, ...args: Args) => B,
      c: (_: B, ...args: Args) => C,
      d: (_: C, ...args: Args) => D,
      e: (_: D, ...args: Args) => E,
      f: (_: E, ...args: Args) => F,
      g: (_: F, ...args: Args) => G,
      h: (_: G, ...args: Args) => H,
      i: (_: H, ...args: Args) => I,
      j: (_: I, ...args: Args) => J,
      k: (_: J, ...args: Args) => K,
      l: (_: K, ...args: Args) => L,
      m: (_: L, ...args: Args) => M,
      n: (_: M, ...args: Args) => N,
      o: (_: N, ...args: Args) => O
    ): (...args: Args) => O
    <
      Self,
      Eff extends Effect<any, any, any>,
      AEff,
      Args extends Array<any>,
      A,
      B,
      C,
      D,
      E,
      F,
      G,
      H,
      I,
      J,
      K,
      L,
      M,
      N,
      O
    >(
      body: (this: Self, ...args: Args) => Generator<Eff, AEff, never>,
      a: (
        _: Effect<
          AEff,
          [Eff] extends [never] ? never
            : [Eff] extends [Effect<infer _A, infer E, infer _R>] ? E
            : never,
          [Eff] extends [never] ? never
            : [Eff] extends [Effect<infer _A, infer _E, infer R>] ? R
            : never
        >,
        ...args: Args
      ) => A,
      b: (_: A, ...args: Args) => B,
      c: (_: B, ...args: Args) => C,
      d: (_: C, ...args: Args) => D,
      e: (_: D, ...args: Args) => E,
      f: (_: E, ...args: Args) => F,
      g: (_: F, ...args: Args) => G,
      h: (_: G, ...args: Args) => H,
      i: (_: H, ...args: Args) => I,
      j: (_: I, ...args: Args) => J,
      k: (_: J, ...args: Args) => K,
      l: (_: K, ...args: Args) => L,
      m: (_: L, ...args: Args) => M,
      n: (_: M, ...args: Args) => N,
      o: (_: N, ...args: Args) => O
    ): (this: Self, ...args: Args) => O
    <
      Eff extends Effect<any, any, any>,
      AEff,
      Args extends Array<any>,
      A,
      B,
      C,
      D,
      E,
      F,
      G,
      H,
      I,
      J,
      K,
      L,
      M,
      N,
      O,
      P
    >(
      body: (this: unassigned, ...args: Args) => Generator<Eff, AEff, never>,
      a: (
        _: Effect<
          AEff,
          [Eff] extends [never] ? never
            : [Eff] extends [Effect<infer _A, infer E, infer _R>] ? E
            : never,
          [Eff] extends [never] ? never
            : [Eff] extends [Effect<infer _A, infer _E, infer R>] ? R
            : never
        >,
        ...args: Args
      ) => A,
      b: (_: A, ...args: Args) => B,
      c: (_: B, ...args: Args) => C,
      d: (_: C, ...args: Args) => D,
      e: (_: D, ...args: Args) => E,
      f: (_: E, ...args: Args) => F,
      g: (_: F, ...args: Args) => G,
      h: (_: G, ...args: Args) => H,
      i: (_: H, ...args: Args) => I,
      j: (_: I, ...args: Args) => J,
      k: (_: J, ...args: Args) => K,
      l: (_: K, ...args: Args) => L,
      m: (_: L, ...args: Args) => M,
      n: (_: M, ...args: Args) => N,
      o: (_: N, ...args: Args) => O,
      p: (_: O, ...args: Args) => P
    ): (...args: Args) => P
    <
      Self,
      Eff extends Effect<any, any, any>,
      AEff,
      Args extends Array<any>,
      A,
      B,
      C,
      D,
      E,
      F,
      G,
      H,
      I,
      J,
      K,
      L,
      M,
      N,
      O,
      P
    >(
      body: (this: Self, ...args: Args) => Generator<Eff, AEff, never>,
      a: (
        _: Effect<
          AEff,
          [Eff] extends [never] ? never
            : [Eff] extends [Effect<infer _A, infer E, infer _R>] ? E
            : never,
          [Eff] extends [never] ? never
            : [Eff] extends [Effect<infer _A, infer _E, infer R>] ? R
            : never
        >,
        ...args: Args
      ) => A,
      b: (_: A, ...args: Args) => B,
      c: (_: B, ...args: Args) => C,
      d: (_: C, ...args: Args) => D,
      e: (_: D, ...args: Args) => E,
      f: (_: E, ...args: Args) => F,
      g: (_: F, ...args: Args) => G,
      h: (_: G, ...args: Args) => H,
      i: (_: H, ...args: Args) => I,
      j: (_: I, ...args: Args) => J,
      k: (_: J, ...args: Args) => K,
      l: (_: K, ...args: Args) => L,
      m: (_: L, ...args: Args) => M,
      n: (_: M, ...args: Args) => N,
      o: (_: N, ...args: Args) => O,
      p: (_: O, ...args: Args) => P
    ): (this: Self, ...args: Args) => P
    <
      Eff extends Effect<any, any, any>,
      AEff,
      Args extends Array<any>,
      A,
      B,
      C,
      D,
      E,
      F,
      G,
      H,
      I,
      J,
      K,
      L,
      M,
      N,
      O,
      P,
      Q
    >(
      body: (this: unassigned, ...args: Args) => Generator<Eff, AEff, never>,
      a: (
        _: Effect<
          AEff,
          [Eff] extends [never] ? never
            : [Eff] extends [Effect<infer _A, infer E, infer _R>] ? E
            : never,
          [Eff] extends [never] ? never
            : [Eff] extends [Effect<infer _A, infer _E, infer R>] ? R
            : never
        >,
        ...args: Args
      ) => A,
      b: (_: A, ...args: Args) => B,
      c: (_: B, ...args: Args) => C,
      d: (_: C, ...args: Args) => D,
      e: (_: D, ...args: Args) => E,
      f: (_: E, ...args: Args) => F,
      g: (_: F, ...args: Args) => G,
      h: (_: G, ...args: Args) => H,
      i: (_: H, ...args: Args) => I,
      j: (_: I, ...args: Args) => J,
      k: (_: J, ...args: Args) => K,
      l: (_: K, ...args: Args) => L,
      m: (_: L, ...args: Args) => M,
      n: (_: M, ...args: Args) => N,
      o: (_: N, ...args: Args) => O,
      p: (_: O, ...args: Args) => P,
      q: (_: P, ...args: Args) => Q
    ): (...args: Args) => Q
    <
      Self,
      Eff extends Effect<any, any, any>,
      AEff,
      Args extends Array<any>,
      A,
      B,
      C,
      D,
      E,
      F,
      G,
      H,
      I,
      J,
      K,
      L,
      M,
      N,
      O,
      P,
      Q
    >(
      body: (this: Self, ...args: Args) => Generator<Eff, AEff, never>,
      a: (
        _: Effect<
          AEff,
          [Eff] extends [never] ? never
            : [Eff] extends [Effect<infer _A, infer E, infer _R>] ? E
            : never,
          [Eff] extends [never] ? never
            : [Eff] extends [Effect<infer _A, infer _E, infer R>] ? R
            : never
        >,
        ...args: Args
      ) => A,
      b: (_: A, ...args: Args) => B,
      c: (_: B, ...args: Args) => C,
      d: (_: C, ...args: Args) => D,
      e: (_: D, ...args: Args) => E,
      f: (_: E, ...args: Args) => F,
      g: (_: F, ...args: Args) => G,
      h: (_: G, ...args: Args) => H,
      i: (_: H, ...args: Args) => I,
      j: (_: I, ...args: Args) => J,
      k: (_: J, ...args: Args) => K,
      l: (_: K, ...args: Args) => L,
      m: (_: L, ...args: Args) => M,
      n: (_: M, ...args: Args) => N,
      o: (_: N, ...args: Args) => O,
      p: (_: O, ...args: Args) => P,
      q: (_: P, ...args: Args) => Q
    ): (this: Self, ...args: Args) => Q
    <
      Eff extends Effect<any, any, any>,
      AEff,
      Args extends Array<any>,
      A,
      B,
      C,
      D,
      E,
      F,
      G,
      H,
      I,
      J,
      K,
      L,
      M,
      N,
      O,
      P,
      Q,
      R
    >(
      body: (this: unassigned, ...args: Args) => Generator<Eff, AEff, never>,
      a: (
        _: Effect<
          AEff,
          [Eff] extends [never] ? never
            : [Eff] extends [Effect<infer _A, infer E, infer _R>] ? E
            : never,
          [Eff] extends [never] ? never
            : [Eff] extends [Effect<infer _A, infer _E, infer R>] ? R
            : never
        >,
        ...args: Args
      ) => A,
      b: (_: A, ...args: Args) => B,
      c: (_: B, ...args: Args) => C,
      d: (_: C, ...args: Args) => D,
      e: (_: D, ...args: Args) => E,
      f: (_: E, ...args: Args) => F,
      g: (_: F, ...args: Args) => G,
      h: (_: G, ...args: Args) => H,
      i: (_: H, ...args: Args) => I,
      j: (_: I, ...args: Args) => J,
      k: (_: J, ...args: Args) => K,
      l: (_: K, ...args: Args) => L,
      m: (_: L, ...args: Args) => M,
      n: (_: M, ...args: Args) => N,
      o: (_: N, ...args: Args) => O,
      p: (_: O, ...args: Args) => P,
      q: (_: P, ...args: Args) => Q,
      r: (_: Q, ...args: Args) => R
    ): (...args: Args) => R
    <
      Self,
      Eff extends Effect<any, any, any>,
      AEff,
      Args extends Array<any>,
      A,
      B,
      C,
      D,
      E,
      F,
      G,
      H,
      I,
      J,
      K,
      L,
      M,
      N,
      O,
      P,
      Q,
      R
    >(
      body: (this: Self, ...args: Args) => Generator<Eff, AEff, never>,
      a: (
        _: Effect<
          AEff,
          [Eff] extends [never] ? never
            : [Eff] extends [Effect<infer _A, infer E, infer _R>] ? E
            : never,
          [Eff] extends [never] ? never
            : [Eff] extends [Effect<infer _A, infer _E, infer R>] ? R
            : never
        >,
        ...args: Args
      ) => A,
      b: (_: A, ...args: Args) => B,
      c: (_: B, ...args: Args) => C,
      d: (_: C, ...args: Args) => D,
      e: (_: D, ...args: Args) => E,
      f: (_: E, ...args: Args) => F,
      g: (_: F, ...args: Args) => G,
      h: (_: G, ...args: Args) => H,
      i: (_: H, ...args: Args) => I,
      j: (_: I, ...args: Args) => J,
      k: (_: J, ...args: Args) => K,
      l: (_: K, ...args: Args) => L,
      m: (_: L, ...args: Args) => M,
      n: (_: M, ...args: Args) => N,
      o: (_: N, ...args: Args) => O,
      p: (_: O, ...args: Args) => P,
      q: (_: P, ...args: Args) => Q,
      r: (_: Q, ...args: Args) => R
    ): (this: Self, ...args: Args) => R
    <
      Eff extends Effect<any, any, any>,
      AEff,
      Args extends Array<any>,
      A,
      B,
      C,
      D,
      E,
      F,
      G,
      H,
      I,
      J,
      K,
      L,
      M,
      N,
      O,
      P,
      Q,
      R,
      S
    >(
      body: (this: unassigned, ...args: Args) => Generator<Eff, AEff, never>,
      a: (
        _: Effect<
          AEff,
          [Eff] extends [never] ? never
            : [Eff] extends [Effect<infer _A, infer E, infer _R>] ? E
            : never,
          [Eff] extends [never] ? never
            : [Eff] extends [Effect<infer _A, infer _E, infer R>] ? R
            : never
        >,
        ...args: Args
      ) => A,
      b: (_: A, ...args: Args) => B,
      c: (_: B, ...args: Args) => C,
      d: (_: C, ...args: Args) => D,
      e: (_: D, ...args: Args) => E,
      f: (_: E, ...args: Args) => F,
      g: (_: F, ...args: Args) => G,
      h: (_: G, ...args: Args) => H,
      i: (_: H, ...args: Args) => I,
      j: (_: I, ...args: Args) => J,
      k: (_: J, ...args: Args) => K,
      l: (_: K, ...args: Args) => L,
      m: (_: L, ...args: Args) => M,
      n: (_: M, ...args: Args) => N,
      o: (_: N, ...args: Args) => O,
      p: (_: O, ...args: Args) => P,
      q: (_: P, ...args: Args) => Q,
      r: (_: Q, ...args: Args) => R,
      s: (_: R, ...args: Args) => S
    ): (...args: Args) => S
    <
      Self,
      Eff extends Effect<any, any, any>,
      AEff,
      Args extends Array<any>,
      A,
      B,
      C,
      D,
      E,
      F,
      G,
      H,
      I,
      J,
      K,
      L,
      M,
      N,
      O,
      P,
      Q,
      R,
      S
    >(
      body: (this: Self, ...args: Args) => Generator<Eff, AEff, never>,
      a: (
        _: Effect<
          AEff,
          [Eff] extends [never] ? never
            : [Eff] extends [Effect<infer _A, infer E, infer _R>] ? E
            : never,
          [Eff] extends [never] ? never
            : [Eff] extends [Effect<infer _A, infer _E, infer R>] ? R
            : never
        >,
        ...args: Args
      ) => A,
      b: (_: A, ...args: Args) => B,
      c: (_: B, ...args: Args) => C,
      d: (_: C, ...args: Args) => D,
      e: (_: D, ...args: Args) => E,
      f: (_: E, ...args: Args) => F,
      g: (_: F, ...args: Args) => G,
      h: (_: G, ...args: Args) => H,
      i: (_: H, ...args: Args) => I,
      j: (_: I, ...args: Args) => J,
      k: (_: J, ...args: Args) => K,
      l: (_: K, ...args: Args) => L,
      m: (_: L, ...args: Args) => M,
      n: (_: M, ...args: Args) => N,
      o: (_: N, ...args: Args) => O,
      p: (_: O, ...args: Args) => P,
      q: (_: P, ...args: Args) => Q,
      r: (_: Q, ...args: Args) => R,
      s: (_: R, ...args: Args) => S
    ): (this: Self, ...args: Args) => S
    <
      Eff extends Effect<any, any, any>,
      AEff,
      Args extends Array<any>,
      A,
      B,
      C,
      D,
      E,
      F,
      G,
      H,
      I,
      J,
      K,
      L,
      M,
      N,
      O,
      P,
      Q,
      R,
      S,
      T
    >(
      body: (this: unassigned, ...args: Args) => Generator<Eff, AEff, never>,
      a: (
        _: Effect<
          AEff,
          [Eff] extends [never] ? never
            : [Eff] extends [Effect<infer _A, infer E, infer _R>] ? E
            : never,
          [Eff] extends [never] ? never
            : [Eff] extends [Effect<infer _A, infer _E, infer R>] ? R
            : never
        >,
        ...args: Args
      ) => A,
      b: (_: A, ...args: Args) => B,
      c: (_: B, ...args: Args) => C,
      d: (_: C, ...args: Args) => D,
      e: (_: D, ...args: Args) => E,
      f: (_: E, ...args: Args) => F,
      g: (_: F, ...args: Args) => G,
      h: (_: G, ...args: Args) => H,
      i: (_: H, ...args: Args) => I,
      j: (_: I, ...args: Args) => J,
      k: (_: J, ...args: Args) => K,
      l: (_: K, ...args: Args) => L,
      m: (_: L, ...args: Args) => M,
      n: (_: M, ...args: Args) => N,
      o: (_: N, ...args: Args) => O,
      p: (_: O, ...args: Args) => P,
      q: (_: P, ...args: Args) => Q,
      r: (_: Q, ...args: Args) => R,
      s: (_: R, ...args: Args) => S,
      t: (_: S, ...args: Args) => T
    ): (...args: Args) => T
    <
      Self,
      Eff extends Effect<any, any, any>,
      AEff,
      Args extends Array<any>,
      A,
      B,
      C,
      D,
      E,
      F,
      G,
      H,
      I,
      J,
      K,
      L,
      M,
      N,
      O,
      P,
      Q,
      R,
      S,
      T
    >(
      body: (this: Self, ...args: Args) => Generator<Eff, AEff, never>,
      a: (
        _: Effect<
          AEff,
          [Eff] extends [never] ? never
            : [Eff] extends [Effect<infer _A, infer E, infer _R>] ? E
            : never,
          [Eff] extends [never] ? never
            : [Eff] extends [Effect<infer _A, infer _E, infer R>] ? R
            : never
        >,
        ...args: Args
      ) => A,
      b: (_: A, ...args: Args) => B,
      c: (_: B, ...args: Args) => C,
      d: (_: C, ...args: Args) => D,
      e: (_: D, ...args: Args) => E,
      f: (_: E, ...args: Args) => F,
      g: (_: F, ...args: Args) => G,
      h: (_: G, ...args: Args) => H,
      i: (_: H, ...args: Args) => I,
      j: (_: I, ...args: Args) => J,
      k: (_: J, ...args: Args) => K,
      l: (_: K, ...args: Args) => L,
      m: (_: L, ...args: Args) => M,
      n: (_: M, ...args: Args) => N,
      o: (_: N, ...args: Args) => O,
      p: (_: O, ...args: Args) => P,
      q: (_: P, ...args: Args) => Q,
      r: (_: Q, ...args: Args) => R,
      s: (_: R, ...args: Args) => S,
      t: (_: S, ...args: Args) => T
    ): (this: Self, ...args: Args) => T
  }

  /**
   * Type of the traced function builder used by `Effect.fn`.
   *
   * @category models
   * @since 4.0.0
   */
  export type Traced = {
    <Eff extends Effect<any, any, any>, AEff, Args extends Array<any>>(
      body: (this: unassigned, ...args: Args) => Generator<Eff, AEff, never> | (Eff & Effect<AEff, any, any>)
    ): (...args: Args) => Effect<
      AEff,
      [Eff] extends [never] ? never
        : [Eff] extends [Effect<infer _A, infer E, infer _R>] ? E
        : never,
      [Eff] extends [never] ? never
        : [Eff] extends [Effect<infer _A, infer _E, infer R>] ? R
        : never
    >
    <Self, Eff extends Effect<any, any, any>, AEff, Args extends Array<any>>(
      body: (this: Self, ...args: Args) => Generator<Eff, AEff, never> | (Eff & Effect<AEff, any, any>)
    ): (this: Self, ...args: Args) => Effect<
      AEff,
      [Eff] extends [never] ? never
        : [Eff] extends [Effect<infer _A, infer E, infer _R>] ? E
        : never,
      [Eff] extends [never] ? never
        : [Eff] extends [Effect<infer _A, infer _E, infer R>] ? R
        : never
    >
    <Self, Eff extends Effect<any, any, any>, AEff, Args extends Array<any>>(
      options: { readonly self: Self },
      body: (this: Self, ...args: Args) => Generator<Eff, AEff, never> | (Eff & Effect<AEff, any, any>)
    ): (...args: Args) => Effect<
      AEff,
      [Eff] extends [never] ? never
        : [Eff] extends [Effect<infer _A, infer E, infer _R>] ? E
        : never,
      [Eff] extends [never] ? never
        : [Eff] extends [Effect<infer _A, infer _E, infer R>] ? R
        : never
    >

    <Eff extends Effect<any, any, any>, AEff, Args extends Array<any>, A>(
      body: (this: unassigned, ...args: Args) => Generator<Eff, AEff, never> | (Eff & Effect<AEff, any, any>),
      a: (
        _: Effect<
          AEff,
          [Eff] extends [never] ? never
            : [Eff] extends [Effect<infer _A, infer E, infer _R>] ? E
            : never,
          [Eff] extends [never] ? never
            : [Eff] extends [Effect<infer _A, infer _E, infer R>] ? R
            : never
        >,
        ...args: Args
      ) => A
    ): (...args: Args) => A
    <Self, Eff extends Effect<any, any, any>, AEff, Args extends Array<any>, A>(
      body: (this: Self, ...args: Args) => Generator<Eff, AEff, never> | (Eff & Effect<AEff, any, any>),
      a: (
        _: Effect<
          AEff,
          [Eff] extends [never] ? never
            : [Eff] extends [Effect<infer _A, infer E, infer _R>] ? E
            : never,
          [Eff] extends [never] ? never
            : [Eff] extends [Effect<infer _A, infer _E, infer R>] ? R
            : never
        >,
        ...args: Args
      ) => A
    ): (this: Self, ...args: Args) => A
    <Self, Eff extends Effect<any, any, any>, AEff, Args extends Array<any>, A>(
      options: { readonly self: Self },
      body: (this: Self, ...args: Args) => Generator<Eff, AEff, never> | (Eff & Effect<AEff, any, any>),
      a: (
        _: Effect<
          AEff,
          [Eff] extends [never] ? never
            : [Eff] extends [Effect<infer _A, infer E, infer _R>] ? E
            : never,
          [Eff] extends [never] ? never
            : [Eff] extends [Effect<infer _A, infer _E, infer R>] ? R
            : never
        >,
        ...args: Args
      ) => A
    ): (...args: Args) => A

    <Eff extends Effect<any, any, any>, AEff, Args extends Array<any>, A, B>(
      body: (this: unassigned, ...args: Args) => Generator<Eff, AEff, never> | (Eff & Effect<AEff, any, any>),
      a: (
        _: Effect<
          AEff,
          [Eff] extends [never] ? never
            : [Eff] extends [Effect<infer _A, infer E, infer _R>] ? E
            : never,
          [Eff] extends [never] ? never
            : [Eff] extends [Effect<infer _A, infer _E, infer R>] ? R
            : never
        >,
        ...args: Args
      ) => A,
      b: (_: A, ...args: Args) => B
    ): (...args: Args) => B
    <Self, Eff extends Effect<any, any, any>, AEff, Args extends Array<any>, A, B>(
      body: (this: Self, ...args: Args) => Generator<Eff, AEff, never> | (Eff & Effect<AEff, any, any>),
      a: (
        _: Effect<
          AEff,
          [Eff] extends [never] ? never
            : [Eff] extends [Effect<infer _A, infer E, infer _R>] ? E
            : never,
          [Eff] extends [never] ? never
            : [Eff] extends [Effect<infer _A, infer _E, infer R>] ? R
            : never
        >,
        ...args: Args
      ) => A,
      b: (_: A, ...args: Args) => B
    ): (this: Self, ...args: Args) => B
    <Self, Eff extends Effect<any, any, any>, AEff, Args extends Array<any>, A, B>(
      options: { readonly self: Self },
      body: (this: Self, ...args: Args) => Generator<Eff, AEff, never> | (Eff & Effect<AEff, any, any>),
      a: (
        _: Effect<
          AEff,
          [Eff] extends [never] ? never
            : [Eff] extends [Effect<infer _A, infer E, infer _R>] ? E
            : never,
          [Eff] extends [never] ? never
            : [Eff] extends [Effect<infer _A, infer _E, infer R>] ? R
            : never
        >,
        ...args: Args
      ) => A,
      b: (_: A, ...args: Args) => B
    ): (...args: Args) => B

    <
      Eff extends Effect<any, any, any>,
      AEff,
      Args extends Array<any>,
      A,
      B,
      C
    >(
      body: (this: unassigned, ...args: Args) => Generator<Eff, AEff, never> | (Eff & Effect<AEff, any, any>),
      a: (
        _: Effect<
          AEff,
          [Eff] extends [never] ? never
            : [Eff] extends [Effect<infer _A, infer E, infer _R>] ? E
            : never,
          [Eff] extends [never] ? never
            : [Eff] extends [Effect<infer _A, infer _E, infer R>] ? R
            : never
        >,
        ...args: Args
      ) => A,
      b: (_: A, ...args: Args) => B,
      c: (_: B, ...args: Args) => C
    ): (...args: Args) => C
    <
      Self,
      Eff extends Effect<any, any, any>,
      AEff,
      Args extends Array<any>,
      A,
      B,
      C
    >(
      body: (this: Self, ...args: Args) => Generator<Eff, AEff, never> | (Eff & Effect<AEff, any, any>),
      a: (
        _: Effect<
          AEff,
          [Eff] extends [never] ? never
            : [Eff] extends [Effect<infer _A, infer E, infer _R>] ? E
            : never,
          [Eff] extends [never] ? never
            : [Eff] extends [Effect<infer _A, infer _E, infer R>] ? R
            : never
        >,
        ...args: Args
      ) => A,
      b: (_: A, ...args: Args) => B,
      c: (_: B, ...args: Args) => C
    ): (this: Self, ...args: Args) => C
    <
      Self,
      Eff extends Effect<any, any, any>,
      AEff,
      Args extends Array<any>,
      A,
      B,
      C
    >(
      options: { readonly self: Self },
      body: (this: Self, ...args: Args) => Generator<Eff, AEff, never> | (Eff & Effect<AEff, any, any>),
      a: (
        _: Effect<
          AEff,
          [Eff] extends [never] ? never
            : [Eff] extends [Effect<infer _A, infer E, infer _R>] ? E
            : never,
          [Eff] extends [never] ? never
            : [Eff] extends [Effect<infer _A, infer _E, infer R>] ? R
            : never
        >,
        ...args: Args
      ) => A,
      b: (_: A, ...args: Args) => B,
      c: (_: B, ...args: Args) => C
    ): (...args: Args) => C

    <
      Eff extends Effect<any, any, any>,
      AEff,
      Args extends Array<any>,
      A,
      B,
      C,
      D
    >(
      body: (this: unassigned, ...args: Args) => Generator<Eff, AEff, never> | (Eff & Effect<AEff, any, any>),
      a: (
        _: Effect<
          AEff,
          [Eff] extends [never] ? never
            : [Eff] extends [Effect<infer _A, infer E, infer _R>] ? E
            : never,
          [Eff] extends [never] ? never
            : [Eff] extends [Effect<infer _A, infer _E, infer R>] ? R
            : never
        >,
        ...args: Args
      ) => A,
      b: (_: A, ...args: Args) => B,
      c: (_: B, ...args: Args) => C,
      d: (_: C, ...args: Args) => D
    ): (...args: Args) => D
    <
      Self,
      Eff extends Effect<any, any, any>,
      AEff,
      Args extends Array<any>,
      A,
      B,
      C,
      D
    >(
      body: (this: Self, ...args: Args) => Generator<Eff, AEff, never> | (Eff & Effect<AEff, any, any>),
      a: (
        _: Effect<
          AEff,
          [Eff] extends [never] ? never
            : [Eff] extends [Effect<infer _A, infer E, infer _R>] ? E
            : never,
          [Eff] extends [never] ? never
            : [Eff] extends [Effect<infer _A, infer _E, infer R>] ? R
            : never
        >,
        ...args: Args
      ) => A,
      b: (_: A, ...args: Args) => B,
      c: (_: B, ...args: Args) => C,
      d: (_: C, ...args: Args) => D
    ): (this: Self, ...args: Args) => D

    <
      Self,
      Eff extends Effect<any, any, any>,
      AEff,
      Args extends Array<any>,
      A,
      B,
      C,
      D
    >(
      options: { readonly self: Self },
      body: (this: Self, ...args: Args) => Generator<Eff, AEff, never> | (Eff & Effect<AEff, any, any>),
      a: (
        _: Effect<
          AEff,
          [Eff] extends [never] ? never
            : [Eff] extends [Effect<infer _A, infer E, infer _R>] ? E
            : never,
          [Eff] extends [never] ? never
            : [Eff] extends [Effect<infer _A, infer _E, infer R>] ? R
            : never
        >,
        ...args: Args
      ) => A,
      b: (_: A, ...args: Args) => B,
      c: (_: B, ...args: Args) => C,
      d: (_: C, ...args: Args) => D
    ): (...args: Args) => D

    <
      Eff extends Effect<any, any, any>,
      AEff,
      Args extends Array<any>,
      A,
      B,
      C,
      D,
      E
    >(
      body: (this: unassigned, ...args: Args) => Generator<Eff, AEff, never> | (Eff & Effect<AEff, any, any>),
      a: (
        _: Effect<
          AEff,
          [Eff] extends [never] ? never
            : [Eff] extends [Effect<infer _A, infer E, infer _R>] ? E
            : never,
          [Eff] extends [never] ? never
            : [Eff] extends [Effect<infer _A, infer _E, infer R>] ? R
            : never
        >,
        ...args: Args
      ) => A,
      b: (_: A, ...args: Args) => B,
      c: (_: B, ...args: Args) => C,
      d: (_: C, ...args: Args) => D,
      e: (_: D, ...args: Args) => E
    ): (...args: Args) => E
    <
      Self,
      Eff extends Effect<any, any, any>,
      AEff,
      Args extends Array<any>,
      A,
      B,
      C,
      D,
      E
    >(
      body: (this: Self, ...args: Args) => Generator<Eff, AEff, never> | (Eff & Effect<AEff, any, any>),
      a: (
        _: Effect<
          AEff,
          [Eff] extends [never] ? never
            : [Eff] extends [Effect<infer _A, infer E, infer _R>] ? E
            : never,
          [Eff] extends [never] ? never
            : [Eff] extends [Effect<infer _A, infer _E, infer R>] ? R
            : never
        >,
        ...args: Args
      ) => A,
      b: (_: A, ...args: Args) => B,
      c: (_: B, ...args: Args) => C,
      d: (_: C, ...args: Args) => D,
      e: (_: D, ...args: Args) => E
    ): (this: Self, ...args: Args) => E

    <
      Self,
      Eff extends Effect<any, any, any>,
      AEff,
      Args extends Array<any>,
      A,
      B,
      C,
      D,
      E
    >(
      options: { readonly self: Self },
      body: (this: Self, ...args: Args) => Generator<Eff, AEff, never> | (Eff & Effect<AEff, any, any>),
      a: (
        _: Effect<
          AEff,
          [Eff] extends [never] ? never
            : [Eff] extends [Effect<infer _A, infer E, infer _R>] ? E
            : never,
          [Eff] extends [never] ? never
            : [Eff] extends [Effect<infer _A, infer _E, infer R>] ? R
            : never
        >,
        ...args: Args
      ) => A,
      b: (_: A, ...args: Args) => B,
      c: (_: B, ...args: Args) => C,
      d: (_: C, ...args: Args) => D,
      e: (_: D, ...args: Args) => E
    ): (...args: Args) => E

    <
      Eff extends Effect<any, any, any>,
      AEff,
      Args extends Array<any>,
      A,
      B,
      C,
      D,
      E,
      F
    >(
      body: (this: unassigned, ...args: Args) => Generator<Eff, AEff, never> | (Eff & Effect<AEff, any, any>),
      a: (
        _: Effect<
          AEff,
          [Eff] extends [never] ? never
            : [Eff] extends [Effect<infer _A, infer E, infer _R>] ? E
            : never,
          [Eff] extends [never] ? never
            : [Eff] extends [Effect<infer _A, infer _E, infer R>] ? R
            : never
        >,
        ...args: Args
      ) => A,
      b: (_: A, ...args: Args) => B,
      c: (_: B, ...args: Args) => C,
      d: (_: C, ...args: Args) => D,
      e: (_: D, ...args: Args) => E,
      f: (_: E, ...args: Args) => F
    ): (...args: Args) => F
    <
      Self,
      Eff extends Effect<any, any, any>,
      AEff,
      Args extends Array<any>,
      A,
      B,
      C,
      D,
      E,
      F
    >(
      body: (this: Self, ...args: Args) => Generator<Eff, AEff, never> | (Eff & Effect<AEff, any, any>),
      a: (
        _: Effect<
          AEff,
          [Eff] extends [never] ? never
            : [Eff] extends [Effect<infer _A, infer E, infer _R>] ? E
            : never,
          [Eff] extends [never] ? never
            : [Eff] extends [Effect<infer _A, infer _E, infer R>] ? R
            : never
        >,
        ...args: Args
      ) => A,
      b: (_: A, ...args: Args) => B,
      c: (_: B, ...args: Args) => C,
      d: (_: C, ...args: Args) => D,
      e: (_: D, ...args: Args) => E,
      f: (_: E, ...args: Args) => F
    ): (this: Self, ...args: Args) => F

    <
      Self,
      Eff extends Effect<any, any, any>,
      AEff,
      Args extends Array<any>,
      A,
      B,
      C,
      D,
      E,
      F
    >(
      options: { readonly self: Self },
      body: (this: Self, ...args: Args) => Generator<Eff, AEff, never> | (Eff & Effect<AEff, any, any>),
      a: (
        _: Effect<
          AEff,
          [Eff] extends [never] ? never
            : [Eff] extends [Effect<infer _A, infer E, infer _R>] ? E
            : never,
          [Eff] extends [never] ? never
            : [Eff] extends [Effect<infer _A, infer _E, infer R>] ? R
            : never
        >,
        ...args: Args
      ) => A,
      b: (_: A, ...args: Args) => B,
      c: (_: B, ...args: Args) => C,
      d: (_: C, ...args: Args) => D,
      e: (_: D, ...args: Args) => E,
      f: (_: E, ...args: Args) => F
    ): (...args: Args) => F

    <
      Eff extends Effect<any, any, any>,
      AEff,
      Args extends Array<any>,
      A,
      B,
      C,
      D,
      E,
      F,
      G
    >(
      body: (this: unassigned, ...args: Args) => Generator<Eff, AEff, never> | (Eff & Effect<AEff, any, any>),
      a: (
        _: Effect<
          AEff,
          [Eff] extends [never] ? never
            : [Eff] extends [Effect<infer _A, infer E, infer _R>] ? E
            : never,
          [Eff] extends [never] ? never
            : [Eff] extends [Effect<infer _A, infer _E, infer R>] ? R
            : never
        >,
        ...args: Args
      ) => A,
      b: (_: A, ...args: Args) => B,
      c: (_: B, ...args: Args) => C,
      d: (_: C, ...args: Args) => D,
      e: (_: D, ...args: Args) => E,
      f: (_: E, ...args: Args) => F,
      g: (_: F, ...args: Args) => G
    ): (...args: Args) => G
    <
      Self,
      Eff extends Effect<any, any, any>,
      AEff,
      Args extends Array<any>,
      A,
      B,
      C,
      D,
      E,
      F,
      G
    >(
      body: (this: Self, ...args: Args) => Generator<Eff, AEff, never> | (Eff & Effect<AEff, any, any>),
      a: (
        _: Effect<
          AEff,
          [Eff] extends [never] ? never
            : [Eff] extends [Effect<infer _A, infer E, infer _R>] ? E
            : never,
          [Eff] extends [never] ? never
            : [Eff] extends [Effect<infer _A, infer _E, infer R>] ? R
            : never
        >,
        ...args: Args
      ) => A,
      b: (_: A, ...args: Args) => B,
      c: (_: B, ...args: Args) => C,
      d: (_: C, ...args: Args) => D,
      e: (_: D, ...args: Args) => E,
      f: (_: E, ...args: Args) => F,
      g: (_: F, ...args: Args) => G
    ): (this: Self, ...args: Args) => G

    <
      Self,
      Eff extends Effect<any, any, any>,
      AEff,
      Args extends Array<any>,
      A,
      B,
      C,
      D,
      E,
      F,
      G
    >(
      options: { readonly self: Self },
      body: (this: Self, ...args: Args) => Generator<Eff, AEff, never> | (Eff & Effect<AEff, any, any>),
      a: (
        _: Effect<
          AEff,
          [Eff] extends [never] ? never
            : [Eff] extends [Effect<infer _A, infer E, infer _R>] ? E
            : never,
          [Eff] extends [never] ? never
            : [Eff] extends [Effect<infer _A, infer _E, infer R>] ? R
            : never
        >,
        ...args: Args
      ) => A,
      b: (_: A, ...args: Args) => B,
      c: (_: B, ...args: Args) => C,
      d: (_: C, ...args: Args) => D,
      e: (_: D, ...args: Args) => E,
      f: (_: E, ...args: Args) => F,
      g: (_: F, ...args: Args) => G
    ): (...args: Args) => G

    <
      Eff extends Effect<any, any, any>,
      AEff,
      Args extends Array<any>,
      A,
      B,
      C,
      D,
      E,
      F,
      G,
      H
    >(
      body: (this: unassigned, ...args: Args) => Generator<Eff, AEff, never> | (Eff & Effect<AEff, any, any>),
      a: (
        _: Effect<
          AEff,
          [Eff] extends [never] ? never
            : [Eff] extends [Effect<infer _A, infer E, infer _R>] ? E
            : never,
          [Eff] extends [never] ? never
            : [Eff] extends [Effect<infer _A, infer _E, infer R>] ? R
            : never
        >,
        ...args: Args
      ) => A,
      b: (_: A, ...args: Args) => B,
      c: (_: B, ...args: Args) => C,
      d: (_: C, ...args: Args) => D,
      e: (_: D, ...args: Args) => E,
      f: (_: E, ...args: Args) => F,
      g: (_: F, ...args: Args) => G,
      h: (_: G, ...args: Args) => H
    ): (...args: Args) => H
    <
      Self,
      Eff extends Effect<any, any, any>,
      AEff,
      Args extends Array<any>,
      A,
      B,
      C,
      D,
      E,
      F,
      G,
      H
    >(
      body: (this: Self, ...args: Args) => Generator<Eff, AEff, never> | (Eff & Effect<AEff, any, any>),
      a: (
        _: Effect<
          AEff,
          [Eff] extends [never] ? never
            : [Eff] extends [Effect<infer _A, infer E, infer _R>] ? E
            : never,
          [Eff] extends [never] ? never
            : [Eff] extends [Effect<infer _A, infer _E, infer R>] ? R
            : never
        >,
        ...args: Args
      ) => A,
      b: (_: A, ...args: Args) => B,
      c: (_: B, ...args: Args) => C,
      d: (_: C, ...args: Args) => D,
      e: (_: D, ...args: Args) => E,
      f: (_: E, ...args: Args) => F,
      g: (_: F, ...args: Args) => G,
      h: (_: G, ...args: Args) => H
    ): (this: Self, ...args: Args) => H

    <
      Self,
      Eff extends Effect<any, any, any>,
      AEff,
      Args extends Array<any>,
      A,
      B,
      C,
      D,
      E,
      F,
      G,
      H
    >(
      options: { readonly self: Self },
      body: (this: Self, ...args: Args) => Generator<Eff, AEff, never> | (Eff & Effect<AEff, any, any>),
      a: (
        _: Effect<
          AEff,
          [Eff] extends [never] ? never
            : [Eff] extends [Effect<infer _A, infer E, infer _R>] ? E
            : never,
          [Eff] extends [never] ? never
            : [Eff] extends [Effect<infer _A, infer _E, infer R>] ? R
            : never
        >,
        ...args: Args
      ) => A,
      b: (_: A, ...args: Args) => B,
      c: (_: B, ...args: Args) => C,
      d: (_: C, ...args: Args) => D,
      e: (_: D, ...args: Args) => E,
      f: (_: E, ...args: Args) => F,
      g: (_: F, ...args: Args) => G,
      h: (_: G, ...args: Args) => H
    ): (...args: Args) => H

    <
      Eff extends Effect<any, any, any>,
      AEff,
      Args extends Array<any>,
      A,
      B,
      C,
      D,
      E,
      F,
      G,
      H,
      I
    >(
      body: (this: unassigned, ...args: Args) => Generator<Eff, AEff, never> | (Eff & Effect<AEff, any, any>),
      a: (
        _: Effect<
          AEff,
          [Eff] extends [never] ? never
            : [Eff] extends [Effect<infer _A, infer E, infer _R>] ? E
            : never,
          [Eff] extends [never] ? never
            : [Eff] extends [Effect<infer _A, infer _E, infer R>] ? R
            : never
        >,
        ...args: Args
      ) => A,
      b: (_: A, ...args: Args) => B,
      c: (_: B, ...args: Args) => C,
      d: (_: C, ...args: Args) => D,
      e: (_: D, ...args: Args) => E,
      f: (_: E, ...args: Args) => F,
      g: (_: F, ...args: Args) => G,
      h: (_: G, ...args: Args) => H,
      i: (_: H, ...args: Args) => I
    ): (...args: Args) => I
    <
      Self,
      Eff extends Effect<any, any, any>,
      AEff,
      Args extends Array<any>,
      A,
      B,
      C,
      D,
      E,
      F,
      G,
      H,
      I
    >(
      body: (this: Self, ...args: Args) => Generator<Eff, AEff, never> | (Eff & Effect<AEff, any, any>),
      a: (
        _: Effect<
          AEff,
          [Eff] extends [never] ? never
            : [Eff] extends [Effect<infer _A, infer E, infer _R>] ? E
            : never,
          [Eff] extends [never] ? never
            : [Eff] extends [Effect<infer _A, infer _E, infer R>] ? R
            : never
        >,
        ...args: Args
      ) => A,
      b: (_: A, ...args: Args) => B,
      c: (_: B, ...args: Args) => C,
      d: (_: C, ...args: Args) => D,
      e: (_: D, ...args: Args) => E,
      f: (_: E, ...args: Args) => F,
      g: (_: F, ...args: Args) => G,
      h: (_: G, ...args: Args) => H,
      i: (_: H, ...args: Args) => I
    ): (this: Self, ...args: Args) => I

    <
      Self,
      Eff extends Effect<any, any, any>,
      AEff,
      Args extends Array<any>,
      A,
      B,
      C,
      D,
      E,
      F,
      G,
      H,
      I
    >(
      options: { readonly self: Self },
      body: (this: Self, ...args: Args) => Generator<Eff, AEff, never> | (Eff & Effect<AEff, any, any>),
      a: (
        _: Effect<
          AEff,
          [Eff] extends [never] ? never
            : [Eff] extends [Effect<infer _A, infer E, infer _R>] ? E
            : never,
          [Eff] extends [never] ? never
            : [Eff] extends [Effect<infer _A, infer _E, infer R>] ? R
            : never
        >,
        ...args: Args
      ) => A,
      b: (_: A, ...args: Args) => B,
      c: (_: B, ...args: Args) => C,
      d: (_: C, ...args: Args) => D,
      e: (_: D, ...args: Args) => E,
      f: (_: E, ...args: Args) => F,
      g: (_: F, ...args: Args) => G,
      h: (_: G, ...args: Args) => H,
      i: (_: H, ...args: Args) => I
    ): (...args: Args) => I

    <
      Eff extends Effect<any, any, any>,
      AEff,
      Args extends Array<any>,
      A,
      B,
      C,
      D,
      E,
      F,
      G,
      H,
      I,
      J
    >(
      body: (this: unassigned, ...args: Args) => Generator<Eff, AEff, never> | (Eff & Effect<AEff, any, any>),
      a: (
        _: Effect<
          AEff,
          [Eff] extends [never] ? never
            : [Eff] extends [Effect<infer _A, infer E, infer _R>] ? E
            : never,
          [Eff] extends [never] ? never
            : [Eff] extends [Effect<infer _A, infer _E, infer R>] ? R
            : never
        >,
        ...args: Args
      ) => A,
      b: (_: A, ...args: Args) => B,
      c: (_: B, ...args: Args) => C,
      d: (_: C, ...args: Args) => D,
      e: (_: D, ...args: Args) => E,
      f: (_: E, ...args: Args) => F,
      g: (_: F, ...args: Args) => G,
      h: (_: G, ...args: Args) => H,
      i: (_: H, ...args: Args) => I,
      j: (_: I, ...args: Args) => J
    ): (...args: Args) => J
    <
      Self,
      Eff extends Effect<any, any, any>,
      AEff,
      Args extends Array<any>,
      A,
      B,
      C,
      D,
      E,
      F,
      G,
      H,
      I,
      J
    >(
      body: (this: Self, ...args: Args) => Generator<Eff, AEff, never> | (Eff & Effect<AEff, any, any>),
      a: (
        _: Effect<
          AEff,
          [Eff] extends [never] ? never
            : [Eff] extends [Effect<infer _A, infer E, infer _R>] ? E
            : never,
          [Eff] extends [never] ? never
            : [Eff] extends [Effect<infer _A, infer _E, infer R>] ? R
            : never
        >,
        ...args: Args
      ) => A,
      b: (_: A, ...args: Args) => B,
      c: (_: B, ...args: Args) => C,
      d: (_: C, ...args: Args) => D,
      e: (_: D, ...args: Args) => E,
      f: (_: E, ...args: Args) => F,
      g: (_: F, ...args: Args) => G,
      h: (_: G, ...args: Args) => H,
      i: (_: H, ...args: Args) => I,
      j: (_: I, ...args: Args) => J
    ): (this: Self, ...args: Args) => J

    <
      Self,
      Eff extends Effect<any, any, any>,
      AEff,
      Args extends Array<any>,
      A,
      B,
      C,
      D,
      E,
      F,
      G,
      H,
      I,
      J
    >(
      options: { readonly self: Self },
      body: (this: Self, ...args: Args) => Generator<Eff, AEff, never> | (Eff & Effect<AEff, any, any>),
      a: (
        _: Effect<
          AEff,
          [Eff] extends [never] ? never
            : [Eff] extends [Effect<infer _A, infer E, infer _R>] ? E
            : never,
          [Eff] extends [never] ? never
            : [Eff] extends [Effect<infer _A, infer _E, infer R>] ? R
            : never
        >,
        ...args: Args
      ) => A,
      b: (_: A, ...args: Args) => B,
      c: (_: B, ...args: Args) => C,
      d: (_: C, ...args: Args) => D,
      e: (_: D, ...args: Args) => E,
      f: (_: E, ...args: Args) => F,
      g: (_: F, ...args: Args) => G,
      h: (_: G, ...args: Args) => H,
      i: (_: H, ...args: Args) => I,
      j: (_: I, ...args: Args) => J
    ): (...args: Args) => J

    <
      Eff extends Effect<any, any, any>,
      AEff,
      Args extends Array<any>,
      A,
      B,
      C,
      D,
      E,
      F,
      G,
      H,
      I,
      J,
      K
    >(
      body: (this: unassigned, ...args: Args) => Generator<Eff, AEff, never> | (Eff & Effect<AEff, any, any>),
      a: (
        _: Effect<
          AEff,
          [Eff] extends [never] ? never
            : [Eff] extends [Effect<infer _A, infer E, infer _R>] ? E
            : never,
          [Eff] extends [never] ? never
            : [Eff] extends [Effect<infer _A, infer _E, infer R>] ? R
            : never
        >,
        ...args: Args
      ) => A,
      b: (_: A, ...args: Args) => B,
      c: (_: B, ...args: Args) => C,
      d: (_: C, ...args: Args) => D,
      e: (_: D, ...args: Args) => E,
      f: (_: E, ...args: Args) => F,
      g: (_: F, ...args: Args) => G,
      h: (_: G, ...args: Args) => H,
      i: (_: H, ...args: Args) => I,
      j: (_: I, ...args: Args) => J,
      k: (_: J, ...args: Args) => K
    ): (...args: Args) => K
    <
      Self,
      Eff extends Effect<any, any, any>,
      AEff,
      Args extends Array<any>,
      A,
      B,
      C,
      D,
      E,
      F,
      G,
      H,
      I,
      J,
      K
    >(
      body: (this: Self, ...args: Args) => Generator<Eff, AEff, never> | (Eff & Effect<AEff, any, any>),
      a: (
        _: Effect<
          AEff,
          [Eff] extends [never] ? never
            : [Eff] extends [Effect<infer _A, infer E, infer _R>] ? E
            : never,
          [Eff] extends [never] ? never
            : [Eff] extends [Effect<infer _A, infer _E, infer R>] ? R
            : never
        >,
        ...args: Args
      ) => A,
      b: (_: A, ...args: Args) => B,
      c: (_: B, ...args: Args) => C,
      d: (_: C, ...args: Args) => D,
      e: (_: D, ...args: Args) => E,
      f: (_: E, ...args: Args) => F,
      g: (_: F, ...args: Args) => G,
      h: (_: G, ...args: Args) => H,
      i: (_: H, ...args: Args) => I,
      j: (_: I, ...args: Args) => J,
      k: (_: J, ...args: Args) => K
    ): (this: Self, ...args: Args) => K

    <
      Self,
      Eff extends Effect<any, any, any>,
      AEff,
      Args extends Array<any>,
      A,
      B,
      C,
      D,
      E,
      F,
      G,
      H,
      I,
      J,
      K
    >(
      options: { readonly self: Self },
      body: (this: Self, ...args: Args) => Generator<Eff, AEff, never> | (Eff & Effect<AEff, any, any>),
      a: (
        _: Effect<
          AEff,
          [Eff] extends [never] ? never
            : [Eff] extends [Effect<infer _A, infer E, infer _R>] ? E
            : never,
          [Eff] extends [never] ? never
            : [Eff] extends [Effect<infer _A, infer _E, infer R>] ? R
            : never
        >,
        ...args: Args
      ) => A,
      b: (_: A, ...args: Args) => B,
      c: (_: B, ...args: Args) => C,
      d: (_: C, ...args: Args) => D,
      e: (_: D, ...args: Args) => E,
      f: (_: E, ...args: Args) => F,
      g: (_: F, ...args: Args) => G,
      h: (_: G, ...args: Args) => H,
      i: (_: H, ...args: Args) => I,
      j: (_: I, ...args: Args) => J,
      k: (_: J, ...args: Args) => K
    ): (...args: Args) => K

    <
      Eff extends Effect<any, any, any>,
      AEff,
      Args extends Array<any>,
      A,
      B,
      C,
      D,
      E,
      F,
      G,
      H,
      I,
      J,
      K,
      L
    >(
      body: (this: unassigned, ...args: Args) => Generator<Eff, AEff, never> | (Eff & Effect<AEff, any, any>),
      a: (
        _: Effect<
          AEff,
          [Eff] extends [never] ? never
            : [Eff] extends [Effect<infer _A, infer E, infer _R>] ? E
            : never,
          [Eff] extends [never] ? never
            : [Eff] extends [Effect<infer _A, infer _E, infer R>] ? R
            : never
        >,
        ...args: Args
      ) => A,
      b: (_: A, ...args: Args) => B,
      c: (_: B, ...args: Args) => C,
      d: (_: C, ...args: Args) => D,
      e: (_: D, ...args: Args) => E,
      f: (_: E, ...args: Args) => F,
      g: (_: F, ...args: Args) => G,
      h: (_: G, ...args: Args) => H,
      i: (_: H, ...args: Args) => I,
      j: (_: I, ...args: Args) => J,
      k: (_: J, ...args: Args) => K,
      l: (_: K, ...args: Args) => L
    ): (...args: Args) => L
    <
      Self,
      Eff extends Effect<any, any, any>,
      AEff,
      Args extends Array<any>,
      A,
      B,
      C,
      D,
      E,
      F,
      G,
      H,
      I,
      J,
      K,
      L
    >(
      body: (this: Self, ...args: Args) => Generator<Eff, AEff, never> | (Eff & Effect<AEff, any, any>),
      a: (
        _: Effect<
          AEff,
          [Eff] extends [never] ? never
            : [Eff] extends [Effect<infer _A, infer E, infer _R>] ? E
            : never,
          [Eff] extends [never] ? never
            : [Eff] extends [Effect<infer _A, infer _E, infer R>] ? R
            : never
        >,
        ...args: Args
      ) => A,
      b: (_: A, ...args: Args) => B,
      c: (_: B, ...args: Args) => C,
      d: (_: C, ...args: Args) => D,
      e: (_: D, ...args: Args) => E,
      f: (_: E, ...args: Args) => F,
      g: (_: F, ...args: Args) => G,
      h: (_: G, ...args: Args) => H,
      i: (_: H, ...args: Args) => I,
      j: (_: I, ...args: Args) => J,
      k: (_: J, ...args: Args) => K,
      l: (_: K, ...args: Args) => L
    ): (this: Self, ...args: Args) => L

    <
      Self,
      Eff extends Effect<any, any, any>,
      AEff,
      Args extends Array<any>,
      A,
      B,
      C,
      D,
      E,
      F,
      G,
      H,
      I,
      J,
      K,
      L
    >(
      options: { readonly self: Self },
      body: (this: Self, ...args: Args) => Generator<Eff, AEff, never> | (Eff & Effect<AEff, any, any>),
      a: (
        _: Effect<
          AEff,
          [Eff] extends [never] ? never
            : [Eff] extends [Effect<infer _A, infer E, infer _R>] ? E
            : never,
          [Eff] extends [never] ? never
            : [Eff] extends [Effect<infer _A, infer _E, infer R>] ? R
            : never
        >,
        ...args: Args
      ) => A,
      b: (_: A, ...args: Args) => B,
      c: (_: B, ...args: Args) => C,
      d: (_: C, ...args: Args) => D,
      e: (_: D, ...args: Args) => E,
      f: (_: E, ...args: Args) => F,
      g: (_: F, ...args: Args) => G,
      h: (_: G, ...args: Args) => H,
      i: (_: H, ...args: Args) => I,
      j: (_: I, ...args: Args) => J,
      k: (_: J, ...args: Args) => K,
      l: (_: K, ...args: Args) => L
    ): (...args: Args) => L

    <
      Eff extends Effect<any, any, any>,
      AEff,
      Args extends Array<any>,
      A,
      B,
      C,
      D,
      E,
      F,
      G,
      H,
      I,
      J,
      K,
      L,
      M
    >(
      body: (this: unassigned, ...args: Args) => Generator<Eff, AEff, never> | (Eff & Effect<AEff, any, any>),
      a: (
        _: Effect<
          AEff,
          [Eff] extends [never] ? never
            : [Eff] extends [Effect<infer _A, infer E, infer _R>] ? E
            : never,
          [Eff] extends [never] ? never
            : [Eff] extends [Effect<infer _A, infer _E, infer R>] ? R
            : never
        >,
        ...args: Args
      ) => A,
      b: (_: A, ...args: Args) => B,
      c: (_: B, ...args: Args) => C,
      d: (_: C, ...args: Args) => D,
      e: (_: D, ...args: Args) => E,
      f: (_: E, ...args: Args) => F,
      g: (_: F, ...args: Args) => G,
      h: (_: G, ...args: Args) => H,
      i: (_: H, ...args: Args) => I,
      j: (_: I, ...args: Args) => J,
      k: (_: J, ...args: Args) => K,
      l: (_: K, ...args: Args) => L,
      m: (_: L, ...args: Args) => M
    ): (...args: Args) => M
    <
      Self,
      Eff extends Effect<any, any, any>,
      AEff,
      Args extends Array<any>,
      A,
      B,
      C,
      D,
      E,
      F,
      G,
      H,
      I,
      J,
      K,
      L,
      M
    >(
      body: (this: Self, ...args: Args) => Generator<Eff, AEff, never> | (Eff & Effect<AEff, any, any>),
      a: (
        _: Effect<
          AEff,
          [Eff] extends [never] ? never
            : [Eff] extends [Effect<infer _A, infer E, infer _R>] ? E
            : never,
          [Eff] extends [never] ? never
            : [Eff] extends [Effect<infer _A, infer _E, infer R>] ? R
            : never
        >,
        ...args: Args
      ) => A,
      b: (_: A, ...args: Args) => B,
      c: (_: B, ...args: Args) => C,
      d: (_: C, ...args: Args) => D,
      e: (_: D, ...args: Args) => E,
      f: (_: E, ...args: Args) => F,
      g: (_: F, ...args: Args) => G,
      h: (_: G, ...args: Args) => H,
      i: (_: H, ...args: Args) => I,
      j: (_: I, ...args: Args) => J,
      k: (_: J, ...args: Args) => K,
      l: (_: K, ...args: Args) => L,
      m: (_: L, ...args: Args) => M
    ): (this: Self, ...args: Args) => M

    <
      Self,
      Eff extends Effect<any, any, any>,
      AEff,
      Args extends Array<any>,
      A,
      B,
      C,
      D,
      E,
      F,
      G,
      H,
      I,
      J,
      K,
      L,
      M
    >(
      options: { readonly self: Self },
      body: (this: Self, ...args: Args) => Generator<Eff, AEff, never> | (Eff & Effect<AEff, any, any>),
      a: (
        _: Effect<
          AEff,
          [Eff] extends [never] ? never
            : [Eff] extends [Effect<infer _A, infer E, infer _R>] ? E
            : never,
          [Eff] extends [never] ? never
            : [Eff] extends [Effect<infer _A, infer _E, infer R>] ? R
            : never
        >,
        ...args: Args
      ) => A,
      b: (_: A, ...args: Args) => B,
      c: (_: B, ...args: Args) => C,
      d: (_: C, ...args: Args) => D,
      e: (_: D, ...args: Args) => E,
      f: (_: E, ...args: Args) => F,
      g: (_: F, ...args: Args) => G,
      h: (_: G, ...args: Args) => H,
      i: (_: H, ...args: Args) => I,
      j: (_: I, ...args: Args) => J,
      k: (_: J, ...args: Args) => K,
      l: (_: K, ...args: Args) => L,
      m: (_: L, ...args: Args) => M
    ): (...args: Args) => M

    <
      Eff extends Effect<any, any, any>,
      AEff,
      Args extends Array<any>,
      A,
      B,
      C,
      D,
      E,
      F,
      G,
      H,
      I,
      J,
      K,
      L,
      M,
      N
    >(
      body: (this: unassigned, ...args: Args) => Generator<Eff, AEff, never> | (Eff & Effect<AEff, any, any>),
      a: (
        _: Effect<
          AEff,
          [Eff] extends [never] ? never
            : [Eff] extends [Effect<infer _A, infer E, infer _R>] ? E
            : never,
          [Eff] extends [never] ? never
            : [Eff] extends [Effect<infer _A, infer _E, infer R>] ? R
            : never
        >,
        ...args: Args
      ) => A,
      b: (_: A, ...args: Args) => B,
      c: (_: B, ...args: Args) => C,
      d: (_: C, ...args: Args) => D,
      e: (_: D, ...args: Args) => E,
      f: (_: E, ...args: Args) => F,
      g: (_: F, ...args: Args) => G,
      h: (_: G, ...args: Args) => H,
      i: (_: H, ...args: Args) => I,
      j: (_: I, ...args: Args) => J,
      k: (_: J, ...args: Args) => K,
      l: (_: K, ...args: Args) => L,
      m: (_: L, ...args: Args) => M,
      n: (_: M, ...args: Args) => N
    ): (...args: Args) => N
    <
      Self,
      Eff extends Effect<any, any, any>,
      AEff,
      Args extends Array<any>,
      A,
      B,
      C,
      D,
      E,
      F,
      G,
      H,
      I,
      J,
      K,
      L,
      M,
      N
    >(
      body: (this: Self, ...args: Args) => Generator<Eff, AEff, never> | (Eff & Effect<AEff, any, any>),
      a: (
        _: Effect<
          AEff,
          [Eff] extends [never] ? never
            : [Eff] extends [Effect<infer _A, infer E, infer _R>] ? E
            : never,
          [Eff] extends [never] ? never
            : [Eff] extends [Effect<infer _A, infer _E, infer R>] ? R
            : never
        >,
        ...args: Args
      ) => A,
      b: (_: A, ...args: Args) => B,
      c: (_: B, ...args: Args) => C,
      d: (_: C, ...args: Args) => D,
      e: (_: D, ...args: Args) => E,
      f: (_: E, ...args: Args) => F,
      g: (_: F, ...args: Args) => G,
      h: (_: G, ...args: Args) => H,
      i: (_: H, ...args: Args) => I,
      j: (_: I, ...args: Args) => J,
      k: (_: J, ...args: Args) => K,
      l: (_: K, ...args: Args) => L,
      m: (_: L, ...args: Args) => M,
      n: (_: M, ...args: Args) => N
    ): (this: Self, ...args: Args) => N

    <
      Self,
      Eff extends Effect<any, any, any>,
      AEff,
      Args extends Array<any>,
      A,
      B,
      C,
      D,
      E,
      F,
      G,
      H,
      I,
      J,
      K,
      L,
      M,
      N
    >(
      options: { readonly self: Self },
      body: (this: Self, ...args: Args) => Generator<Eff, AEff, never> | (Eff & Effect<AEff, any, any>),
      a: (
        _: Effect<
          AEff,
          [Eff] extends [never] ? never
            : [Eff] extends [Effect<infer _A, infer E, infer _R>] ? E
            : never,
          [Eff] extends [never] ? never
            : [Eff] extends [Effect<infer _A, infer _E, infer R>] ? R
            : never
        >,
        ...args: Args
      ) => A,
      b: (_: A, ...args: Args) => B,
      c: (_: B, ...args: Args) => C,
      d: (_: C, ...args: Args) => D,
      e: (_: D, ...args: Args) => E,
      f: (_: E, ...args: Args) => F,
      g: (_: F, ...args: Args) => G,
      h: (_: G, ...args: Args) => H,
      i: (_: H, ...args: Args) => I,
      j: (_: I, ...args: Args) => J,
      k: (_: J, ...args: Args) => K,
      l: (_: K, ...args: Args) => L,
      m: (_: L, ...args: Args) => M,
      n: (_: M, ...args: Args) => N
    ): (...args: Args) => N

    <
      Eff extends Effect<any, any, any>,
      AEff,
      Args extends Array<any>,
      A,
      B,
      C,
      D,
      E,
      F,
      G,
      H,
      I,
      J,
      K,
      L,
      M,
      N,
      O
    >(
      body: (this: unassigned, ...args: Args) => Generator<Eff, AEff, never> | (Eff & Effect<AEff, any, any>),
      a: (
        _: Effect<
          AEff,
          [Eff] extends [never] ? never
            : [Eff] extends [Effect<infer _A, infer E, infer _R>] ? E
            : never,
          [Eff] extends [never] ? never
            : [Eff] extends [Effect<infer _A, infer _E, infer R>] ? R
            : never
        >,
        ...args: Args
      ) => A,
      b: (_: A, ...args: Args) => B,
      c: (_: B, ...args: Args) => C,
      d: (_: C, ...args: Args) => D,
      e: (_: D, ...args: Args) => E,
      f: (_: E, ...args: Args) => F,
      g: (_: F, ...args: Args) => G,
      h: (_: G, ...args: Args) => H,
      i: (_: H, ...args: Args) => I,
      j: (_: I, ...args: Args) => J,
      k: (_: J, ...args: Args) => K,
      l: (_: K, ...args: Args) => L,
      m: (_: L, ...args: Args) => M,
      n: (_: M, ...args: Args) => N,
      o: (_: N, ...args: Args) => O
    ): (...args: Args) => O
    <
      Self,
      Eff extends Effect<any, any, any>,
      AEff,
      Args extends Array<any>,
      A,
      B,
      C,
      D,
      E,
      F,
      G,
      H,
      I,
      J,
      K,
      L,
      M,
      N,
      O
    >(
      body: (this: Self, ...args: Args) => Generator<Eff, AEff, never> | (Eff & Effect<AEff, any, any>),
      a: (
        _: Effect<
          AEff,
          [Eff] extends [never] ? never
            : [Eff] extends [Effect<infer _A, infer E, infer _R>] ? E
            : never,
          [Eff] extends [never] ? never
            : [Eff] extends [Effect<infer _A, infer _E, infer R>] ? R
            : never
        >,
        ...args: Args
      ) => A,
      b: (_: A, ...args: Args) => B,
      c: (_: B, ...args: Args) => C,
      d: (_: C, ...args: Args) => D,
      e: (_: D, ...args: Args) => E,
      f: (_: E, ...args: Args) => F,
      g: (_: F, ...args: Args) => G,
      h: (_: G, ...args: Args) => H,
      i: (_: H, ...args: Args) => I,
      j: (_: I, ...args: Args) => J,
      k: (_: J, ...args: Args) => K,
      l: (_: K, ...args: Args) => L,
      m: (_: L, ...args: Args) => M,
      n: (_: M, ...args: Args) => N,
      o: (_: N, ...args: Args) => O
    ): (this: Self, ...args: Args) => O

    <
      Self,
      Eff extends Effect<any, any, any>,
      AEff,
      Args extends Array<any>,
      A,
      B,
      C,
      D,
      E,
      F,
      G,
      H,
      I,
      J,
      K,
      L,
      M,
      N,
      O
    >(
      options: { readonly self: Self },
      body: (this: Self, ...args: Args) => Generator<Eff, AEff, never> | (Eff & Effect<AEff, any, any>),
      a: (
        _: Effect<
          AEff,
          [Eff] extends [never] ? never
            : [Eff] extends [Effect<infer _A, infer E, infer _R>] ? E
            : never,
          [Eff] extends [never] ? never
            : [Eff] extends [Effect<infer _A, infer _E, infer R>] ? R
            : never
        >,
        ...args: Args
      ) => A,
      b: (_: A, ...args: Args) => B,
      c: (_: B, ...args: Args) => C,
      d: (_: C, ...args: Args) => D,
      e: (_: D, ...args: Args) => E,
      f: (_: E, ...args: Args) => F,
      g: (_: F, ...args: Args) => G,
      h: (_: G, ...args: Args) => H,
      i: (_: H, ...args: Args) => I,
      j: (_: I, ...args: Args) => J,
      k: (_: J, ...args: Args) => K,
      l: (_: K, ...args: Args) => L,
      m: (_: L, ...args: Args) => M,
      n: (_: M, ...args: Args) => N,
      o: (_: N, ...args: Args) => O
    ): (...args: Args) => O

    <
      Eff extends Effect<any, any, any>,
      AEff,
      Args extends Array<any>,
      A,
      B,
      C,
      D,
      E,
      F,
      G,
      H,
      I,
      J,
      K,
      L,
      M,
      N,
      O,
      P
    >(
      body: (this: unassigned, ...args: Args) => Generator<Eff, AEff, never> | (Eff & Effect<AEff, any, any>),
      a: (
        _: Effect<
          AEff,
          [Eff] extends [never] ? never
            : [Eff] extends [Effect<infer _A, infer E, infer _R>] ? E
            : never,
          [Eff] extends [never] ? never
            : [Eff] extends [Effect<infer _A, infer _E, infer R>] ? R
            : never
        >,
        ...args: Args
      ) => A,
      b: (_: A, ...args: Args) => B,
      c: (_: B, ...args: Args) => C,
      d: (_: C, ...args: Args) => D,
      e: (_: D, ...args: Args) => E,
      f: (_: E, ...args: Args) => F,
      g: (_: F, ...args: Args) => G,
      h: (_: G, ...args: Args) => H,
      i: (_: H, ...args: Args) => I,
      j: (_: I, ...args: Args) => J,
      k: (_: J, ...args: Args) => K,
      l: (_: K, ...args: Args) => L,
      m: (_: L, ...args: Args) => M,
      n: (_: M, ...args: Args) => N,
      o: (_: N, ...args: Args) => O,
      p: (_: O, ...args: Args) => P
    ): (...args: Args) => P
    <
      Self,
      Eff extends Effect<any, any, any>,
      AEff,
      Args extends Array<any>,
      A,
      B,
      C,
      D,
      E,
      F,
      G,
      H,
      I,
      J,
      K,
      L,
      M,
      N,
      O,
      P
    >(
      body: (this: Self, ...args: Args) => Generator<Eff, AEff, never> | (Eff & Effect<AEff, any, any>),
      a: (
        _: Effect<
          AEff,
          [Eff] extends [never] ? never
            : [Eff] extends [Effect<infer _A, infer E, infer _R>] ? E
            : never,
          [Eff] extends [never] ? never
            : [Eff] extends [Effect<infer _A, infer _E, infer R>] ? R
            : never
        >,
        ...args: Args
      ) => A,
      b: (_: A, ...args: Args) => B,
      c: (_: B, ...args: Args) => C,
      d: (_: C, ...args: Args) => D,
      e: (_: D, ...args: Args) => E,
      f: (_: E, ...args: Args) => F,
      g: (_: F, ...args: Args) => G,
      h: (_: G, ...args: Args) => H,
      i: (_: H, ...args: Args) => I,
      j: (_: I, ...args: Args) => J,
      k: (_: J, ...args: Args) => K,
      l: (_: K, ...args: Args) => L,
      m: (_: L, ...args: Args) => M,
      n: (_: M, ...args: Args) => N,
      o: (_: N, ...args: Args) => O,
      p: (_: O, ...args: Args) => P
    ): (this: Self, ...args: Args) => P

    <
      Self,
      Eff extends Effect<any, any, any>,
      AEff,
      Args extends Array<any>,
      A,
      B,
      C,
      D,
      E,
      F,
      G,
      H,
      I,
      J,
      K,
      L,
      M,
      N,
      O,
      P
    >(
      options: { readonly self: Self },
      body: (this: Self, ...args: Args) => Generator<Eff, AEff, never> | (Eff & Effect<AEff, any, any>),
      a: (
        _: Effect<
          AEff,
          [Eff] extends [never] ? never
            : [Eff] extends [Effect<infer _A, infer E, infer _R>] ? E
            : never,
          [Eff] extends [never] ? never
            : [Eff] extends [Effect<infer _A, infer _E, infer R>] ? R
            : never
        >,
        ...args: Args
      ) => A,
      b: (_: A, ...args: Args) => B,
      c: (_: B, ...args: Args) => C,
      d: (_: C, ...args: Args) => D,
      e: (_: D, ...args: Args) => E,
      f: (_: E, ...args: Args) => F,
      g: (_: F, ...args: Args) => G,
      h: (_: G, ...args: Args) => H,
      i: (_: H, ...args: Args) => I,
      j: (_: I, ...args: Args) => J,
      k: (_: J, ...args: Args) => K,
      l: (_: K, ...args: Args) => L,
      m: (_: L, ...args: Args) => M,
      n: (_: M, ...args: Args) => N,
      o: (_: N, ...args: Args) => O,
      p: (_: O, ...args: Args) => P
    ): (...args: Args) => P

    <
      Eff extends Effect<any, any, any>,
      AEff,
      Args extends Array<any>,
      A,
      B,
      C,
      D,
      E,
      F,
      G,
      H,
      I,
      J,
      K,
      L,
      M,
      N,
      O,
      P,
      Q
    >(
      body: (this: unassigned, ...args: Args) => Generator<Eff, AEff, never> | (Eff & Effect<AEff, any, any>),
      a: (
        _: Effect<
          AEff,
          [Eff] extends [never] ? never
            : [Eff] extends [Effect<infer _A, infer E, infer _R>] ? E
            : never,
          [Eff] extends [never] ? never
            : [Eff] extends [Effect<infer _A, infer _E, infer R>] ? R
            : never
        >,
        ...args: Args
      ) => A,
      b: (_: A, ...args: Args) => B,
      c: (_: B, ...args: Args) => C,
      d: (_: C, ...args: Args) => D,
      e: (_: D, ...args: Args) => E,
      f: (_: E, ...args: Args) => F,
      g: (_: F, ...args: Args) => G,
      h: (_: G, ...args: Args) => H,
      i: (_: H, ...args: Args) => I,
      j: (_: I, ...args: Args) => J,
      k: (_: J, ...args: Args) => K,
      l: (_: K, ...args: Args) => L,
      m: (_: L, ...args: Args) => M,
      n: (_: M, ...args: Args) => N,
      o: (_: N, ...args: Args) => O,
      p: (_: O, ...args: Args) => P,
      q: (_: P, ...args: Args) => Q
    ): (...args: Args) => Q
    <
      Self,
      Eff extends Effect<any, any, any>,
      AEff,
      Args extends Array<any>,
      A,
      B,
      C,
      D,
      E,
      F,
      G,
      H,
      I,
      J,
      K,
      L,
      M,
      N,
      O,
      P,
      Q
    >(
      body: (this: Self, ...args: Args) => Generator<Eff, AEff, never> | (Eff & Effect<AEff, any, any>),
      a: (
        _: Effect<
          AEff,
          [Eff] extends [never] ? never
            : [Eff] extends [Effect<infer _A, infer E, infer _R>] ? E
            : never,
          [Eff] extends [never] ? never
            : [Eff] extends [Effect<infer _A, infer _E, infer R>] ? R
            : never
        >,
        ...args: Args
      ) => A,
      b: (_: A, ...args: Args) => B,
      c: (_: B, ...args: Args) => C,
      d: (_: C, ...args: Args) => D,
      e: (_: D, ...args: Args) => E,
      f: (_: E, ...args: Args) => F,
      g: (_: F, ...args: Args) => G,
      h: (_: G, ...args: Args) => H,
      i: (_: H, ...args: Args) => I,
      j: (_: I, ...args: Args) => J,
      k: (_: J, ...args: Args) => K,
      l: (_: K, ...args: Args) => L,
      m: (_: L, ...args: Args) => M,
      n: (_: M, ...args: Args) => N,
      o: (_: N, ...args: Args) => O,
      p: (_: O, ...args: Args) => P,
      q: (_: P, ...args: Args) => Q
    ): (this: Self, ...args: Args) => Q

    <
      Self,
      Eff extends Effect<any, any, any>,
      AEff,
      Args extends Array<any>,
      A,
      B,
      C,
      D,
      E,
      F,
      G,
      H,
      I,
      J,
      K,
      L,
      M,
      N,
      O,
      P,
      Q
    >(
      options: { readonly self: Self },
      body: (this: Self, ...args: Args) => Generator<Eff, AEff, never> | (Eff & Effect<AEff, any, any>),
      a: (
        _: Effect<
          AEff,
          [Eff] extends [never] ? never
            : [Eff] extends [Effect<infer _A, infer E, infer _R>] ? E
            : never,
          [Eff] extends [never] ? never
            : [Eff] extends [Effect<infer _A, infer _E, infer R>] ? R
            : never
        >,
        ...args: Args
      ) => A,
      b: (_: A, ...args: Args) => B,
      c: (_: B, ...args: Args) => C,
      d: (_: C, ...args: Args) => D,
      e: (_: D, ...args: Args) => E,
      f: (_: E, ...args: Args) => F,
      g: (_: F, ...args: Args) => G,
      h: (_: G, ...args: Args) => H,
      i: (_: H, ...args: Args) => I,
      j: (_: I, ...args: Args) => J,
      k: (_: J, ...args: Args) => K,
      l: (_: K, ...args: Args) => L,
      m: (_: L, ...args: Args) => M,
      n: (_: M, ...args: Args) => N,
      o: (_: N, ...args: Args) => O,
      p: (_: O, ...args: Args) => P,
      q: (_: P, ...args: Args) => Q
    ): (...args: Args) => Q

    <
      Eff extends Effect<any, any, any>,
      AEff,
      Args extends Array<any>,
      A,
      B,
      C,
      D,
      E,
      F,
      G,
      H,
      I,
      J,
      K,
      L,
      M,
      N,
      O,
      P,
      Q,
      R
    >(
      body: (this: unassigned, ...args: Args) => Generator<Eff, AEff, never> | (Eff & Effect<AEff, any, any>),
      a: (
        _: Effect<
          AEff,
          [Eff] extends [never] ? never
            : [Eff] extends [Effect<infer _A, infer E, infer _R>] ? E
            : never,
          [Eff] extends [never] ? never
            : [Eff] extends [Effect<infer _A, infer _E, infer R>] ? R
            : never
        >,
        ...args: Args
      ) => A,
      b: (_: A, ...args: Args) => B,
      c: (_: B, ...args: Args) => C,
      d: (_: C, ...args: Args) => D,
      e: (_: D, ...args: Args) => E,
      f: (_: E, ...args: Args) => F,
      g: (_: F, ...args: Args) => G,
      h: (_: G, ...args: Args) => H,
      i: (_: H, ...args: Args) => I,
      j: (_: I, ...args: Args) => J,
      k: (_: J, ...args: Args) => K,
      l: (_: K, ...args: Args) => L,
      m: (_: L, ...args: Args) => M,
      n: (_: M, ...args: Args) => N,
      o: (_: N, ...args: Args) => O,
      p: (_: O, ...args: Args) => P,
      q: (_: P, ...args: Args) => Q,
      r: (_: Q, ...args: Args) => R
    ): (...args: Args) => R
    <
      Self,
      Eff extends Effect<any, any, any>,
      AEff,
      Args extends Array<any>,
      A,
      B,
      C,
      D,
      E,
      F,
      G,
      H,
      I,
      J,
      K,
      L,
      M,
      N,
      O,
      P,
      Q,
      R
    >(
      body: (this: Self, ...args: Args) => Generator<Eff, AEff, never> | (Eff & Effect<AEff, any, any>),
      a: (
        _: Effect<
          AEff,
          [Eff] extends [never] ? never
            : [Eff] extends [Effect<infer _A, infer E, infer _R>] ? E
            : never,
          [Eff] extends [never] ? never
            : [Eff] extends [Effect<infer _A, infer _E, infer R>] ? R
            : never
        >,
        ...args: Args
      ) => A,
      b: (_: A, ...args: Args) => B,
      c: (_: B, ...args: Args) => C,
      d: (_: C, ...args: Args) => D,
      e: (_: D, ...args: Args) => E,
      f: (_: E, ...args: Args) => F,
      g: (_: F, ...args: Args) => G,
      h: (_: G, ...args: Args) => H,
      i: (_: H, ...args: Args) => I,
      j: (_: I, ...args: Args) => J,
      k: (_: J, ...args: Args) => K,
      l: (_: K, ...args: Args) => L,
      m: (_: L, ...args: Args) => M,
      n: (_: M, ...args: Args) => N,
      o: (_: N, ...args: Args) => O,
      p: (_: O, ...args: Args) => P,
      q: (_: P, ...args: Args) => Q,
      r: (_: Q, ...args: Args) => R
    ): (this: Self, ...args: Args) => R

    <
      Self,
      Eff extends Effect<any, any, any>,
      AEff,
      Args extends Array<any>,
      A,
      B,
      C,
      D,
      E,
      F,
      G,
      H,
      I,
      J,
      K,
      L,
      M,
      N,
      O,
      P,
      Q,
      R
    >(
      options: { readonly self: Self },
      body: (this: Self, ...args: Args) => Generator<Eff, AEff, never> | (Eff & Effect<AEff, any, any>),
      a: (
        _: Effect<
          AEff,
          [Eff] extends [never] ? never
            : [Eff] extends [Effect<infer _A, infer E, infer _R>] ? E
            : never,
          [Eff] extends [never] ? never
            : [Eff] extends [Effect<infer _A, infer _E, infer R>] ? R
            : never
        >,
        ...args: Args
      ) => A,
      b: (_: A, ...args: Args) => B,
      c: (_: B, ...args: Args) => C,
      d: (_: C, ...args: Args) => D,
      e: (_: D, ...args: Args) => E,
      f: (_: E, ...args: Args) => F,
      g: (_: F, ...args: Args) => G,
      h: (_: G, ...args: Args) => H,
      i: (_: H, ...args: Args) => I,
      j: (_: I, ...args: Args) => J,
      k: (_: J, ...args: Args) => K,
      l: (_: K, ...args: Args) => L,
      m: (_: L, ...args: Args) => M,
      n: (_: M, ...args: Args) => N,
      o: (_: N, ...args: Args) => O,
      p: (_: O, ...args: Args) => P,
      q: (_: P, ...args: Args) => Q,
      r: (_: Q, ...args: Args) => R
    ): (...args: Args) => R

    <
      Eff extends Effect<any, any, any>,
      AEff,
      Args extends Array<any>,
      A,
      B,
      C,
      D,
      E,
      F,
      G,
      H,
      I,
      J,
      K,
      L,
      M,
      N,
      O,
      P,
      Q,
      R,
      S
    >(
      body: (this: unassigned, ...args: Args) => Generator<Eff, AEff, never> | (Eff & Effect<AEff, any, any>),
      a: (
        _: Effect<
          AEff,
          [Eff] extends [never] ? never
            : [Eff] extends [Effect<infer _A, infer E, infer _R>] ? E
            : never,
          [Eff] extends [never] ? never
            : [Eff] extends [Effect<infer _A, infer _E, infer R>] ? R
            : never
        >,
        ...args: Args
      ) => A,
      b: (_: A, ...args: Args) => B,
      c: (_: B, ...args: Args) => C,
      d: (_: C, ...args: Args) => D,
      e: (_: D, ...args: Args) => E,
      f: (_: E, ...args: Args) => F,
      g: (_: F, ...args: Args) => G,
      h: (_: G, ...args: Args) => H,
      i: (_: H, ...args: Args) => I,
      j: (_: I, ...args: Args) => J,
      k: (_: J, ...args: Args) => K,
      l: (_: K, ...args: Args) => L,
      m: (_: L, ...args: Args) => M,
      n: (_: M, ...args: Args) => N,
      o: (_: N, ...args: Args) => O,
      p: (_: O, ...args: Args) => P,
      q: (_: P, ...args: Args) => Q,
      r: (_: Q, ...args: Args) => R,
      s: (_: R, ...args: Args) => S
    ): (...args: Args) => S
    <
      Self,
      Eff extends Effect<any, any, any>,
      AEff,
      Args extends Array<any>,
      A,
      B,
      C,
      D,
      E,
      F,
      G,
      H,
      I,
      J,
      K,
      L,
      M,
      N,
      O,
      P,
      Q,
      R,
      S
    >(
      body: (this: Self, ...args: Args) => Generator<Eff, AEff, never> | (Eff & Effect<AEff, any, any>),
      a: (
        _: Effect<
          AEff,
          [Eff] extends [never] ? never
            : [Eff] extends [Effect<infer _A, infer E, infer _R>] ? E
            : never,
          [Eff] extends [never] ? never
            : [Eff] extends [Effect<infer _A, infer _E, infer R>] ? R
            : never
        >,
        ...args: Args
      ) => A,
      b: (_: A, ...args: Args) => B,
      c: (_: B, ...args: Args) => C,
      d: (_: C, ...args: Args) => D,
      e: (_: D, ...args: Args) => E,
      f: (_: E, ...args: Args) => F,
      g: (_: F, ...args: Args) => G,
      h: (_: G, ...args: Args) => H,
      i: (_: H, ...args: Args) => I,
      j: (_: I, ...args: Args) => J,
      k: (_: J, ...args: Args) => K,
      l: (_: K, ...args: Args) => L,
      m: (_: L, ...args: Args) => M,
      n: (_: M, ...args: Args) => N,
      o: (_: N, ...args: Args) => O,
      p: (_: O, ...args: Args) => P,
      q: (_: P, ...args: Args) => Q,
      r: (_: Q, ...args: Args) => R,
      s: (_: R, ...args: Args) => S
    ): (this: Self, ...args: Args) => S

    <
      Self,
      Eff extends Effect<any, any, any>,
      AEff,
      Args extends Array<any>,
      A,
      B,
      C,
      D,
      E,
      F,
      G,
      H,
      I,
      J,
      K,
      L,
      M,
      N,
      O,
      P,
      Q,
      R,
      S
    >(
      options: { readonly self: Self },
      body: (this: Self, ...args: Args) => Generator<Eff, AEff, never> | (Eff & Effect<AEff, any, any>),
      a: (
        _: Effect<
          AEff,
          [Eff] extends [never] ? never
            : [Eff] extends [Effect<infer _A, infer E, infer _R>] ? E
            : never,
          [Eff] extends [never] ? never
            : [Eff] extends [Effect<infer _A, infer _E, infer R>] ? R
            : never
        >,
        ...args: Args
      ) => A,
      b: (_: A, ...args: Args) => B,
      c: (_: B, ...args: Args) => C,
      d: (_: C, ...args: Args) => D,
      e: (_: D, ...args: Args) => E,
      f: (_: E, ...args: Args) => F,
      g: (_: F, ...args: Args) => G,
      h: (_: G, ...args: Args) => H,
      i: (_: H, ...args: Args) => I,
      j: (_: I, ...args: Args) => J,
      k: (_: J, ...args: Args) => K,
      l: (_: K, ...args: Args) => L,
      m: (_: L, ...args: Args) => M,
      n: (_: M, ...args: Args) => N,
      o: (_: N, ...args: Args) => O,
      p: (_: O, ...args: Args) => P,
      q: (_: P, ...args: Args) => Q,
      r: (_: Q, ...args: Args) => R,
      s: (_: R, ...args: Args) => S
    ): (...args: Args) => S

    <
      Eff extends Effect<any, any, any>,
      AEff,
      Args extends Array<any>,
      A,
      B,
      C,
      D,
      E,
      F,
      G,
      H,
      I,
      J,
      K,
      L,
      M,
      N,
      O,
      P,
      Q,
      R,
      S,
      T
    >(
      body: (this: unassigned, ...args: Args) => Generator<Eff, AEff, never> | (Eff & Effect<AEff, any, any>),
      a: (
        _: Effect<
          AEff,
          [Eff] extends [never] ? never
            : [Eff] extends [Effect<infer _A, infer E, infer _R>] ? E
            : never,
          [Eff] extends [never] ? never
            : [Eff] extends [Effect<infer _A, infer _E, infer R>] ? R
            : never
        >,
        ...args: Args
      ) => A,
      b: (_: A, ...args: Args) => B,
      c: (_: B, ...args: Args) => C,
      d: (_: C, ...args: Args) => D,
      e: (_: D, ...args: Args) => E,
      f: (_: E, ...args: Args) => F,
      g: (_: F, ...args: Args) => G,
      h: (_: G, ...args: Args) => H,
      i: (_: H, ...args: Args) => I,
      j: (_: I, ...args: Args) => J,
      k: (_: J, ...args: Args) => K,
      l: (_: K, ...args: Args) => L,
      m: (_: L, ...args: Args) => M,
      n: (_: M, ...args: Args) => N,
      o: (_: N, ...args: Args) => O,
      p: (_: O, ...args: Args) => P,
      q: (_: P, ...args: Args) => Q,
      r: (_: Q, ...args: Args) => R,
      s: (_: R, ...args: Args) => S,
      t: (_: S, ...args: Args) => T
    ): (...args: Args) => T
    <
      Self,
      Eff extends Effect<any, any, any>,
      AEff,
      Args extends Array<any>,
      A,
      B,
      C,
      D,
      E,
      F,
      G,
      H,
      I,
      J,
      K,
      L,
      M,
      N,
      O,
      P,
      Q,
      R,
      S,
      T
    >(
      body: (this: Self, ...args: Args) => Generator<Eff, AEff, never> | (Eff & Effect<AEff, any, any>),
      a: (
        _: Effect<
          AEff,
          [Eff] extends [never] ? never
            : [Eff] extends [Effect<infer _A, infer E, infer _R>] ? E
            : never,
          [Eff] extends [never] ? never
            : [Eff] extends [Effect<infer _A, infer _E, infer R>] ? R
            : never
        >,
        ...args: Args
      ) => A,
      b: (_: A, ...args: Args) => B,
      c: (_: B, ...args: Args) => C,
      d: (_: C, ...args: Args) => D,
      e: (_: D, ...args: Args) => E,
      f: (_: E, ...args: Args) => F,
      g: (_: F, ...args: Args) => G,
      h: (_: G, ...args: Args) => H,
      i: (_: H, ...args: Args) => I,
      j: (_: I, ...args: Args) => J,
      k: (_: J, ...args: Args) => K,
      l: (_: K, ...args: Args) => L,
      m: (_: L, ...args: Args) => M,
      n: (_: M, ...args: Args) => N,
      o: (_: N, ...args: Args) => O,
      p: (_: O, ...args: Args) => P,
      q: (_: P, ...args: Args) => Q,
      r: (_: Q, ...args: Args) => R,
      s: (_: R, ...args: Args) => S,
      t: (_: S, ...args: Args) => T
    ): (this: Self, ...args: Args) => T

    <
      Self,
      Eff extends Effect<any, any, any>,
      AEff,
      Args extends Array<any>,
      A,
      B,
      C,
      D,
      E,
      F,
      G,
      H,
      I,
      J,
      K,
      L,
      M,
      N,
      O,
      P,
      Q,
      R,
      S,
      T
    >(
      options: { readonly self: Self },
      body: (this: Self, ...args: Args) => Generator<Eff, AEff, never> | (Eff & Effect<AEff, any, any>),
      a: (
        _: Effect<
          AEff,
          [Eff] extends [never] ? never
            : [Eff] extends [Effect<infer _A, infer E, infer _R>] ? E
            : never,
          [Eff] extends [never] ? never
            : [Eff] extends [Effect<infer _A, infer _E, infer R>] ? R
            : never
        >,
        ...args: Args
      ) => A,
      b: (_: A, ...args: Args) => B,
      c: (_: B, ...args: Args) => C,
      d: (_: C, ...args: Args) => D,
      e: (_: D, ...args: Args) => E,
      f: (_: E, ...args: Args) => F,
      g: (_: F, ...args: Args) => G,
      h: (_: G, ...args: Args) => H,
      i: (_: H, ...args: Args) => I,
      j: (_: I, ...args: Args) => J,
      k: (_: J, ...args: Args) => K,
      l: (_: K, ...args: Args) => L,
      m: (_: L, ...args: Args) => M,
      n: (_: M, ...args: Args) => N,
      o: (_: N, ...args: Args) => O,
      p: (_: O, ...args: Args) => P,
      q: (_: P, ...args: Args) => Q,
      r: (_: Q, ...args: Args) => R,
      s: (_: R, ...args: Args) => S,
      t: (_: S, ...args: Args) => T
    ): (...args: Args) => T
  }
}

/**
 * Creates an Effect-returning function without tracing.
 *
 * **Details**
 *
 * `Effect.fnUntraced` also acts as a `pipe` function, so you can append transforms after the body.
 *
 * **Example** (Defining untraced effect functions)
 *
 * ```ts
 * import { Console, Effect } from "effect"
 *
 * const greet = Effect.fnUntraced(function* (name: string) {
 *   yield* Console.log(`Hello, ${name}`)
 *   return name.length
 * })
 *
 * Effect.runFork(greet("Ada"))
 * ```
 *
 * @category functions
 * @since 3.12.0
 */
export const fnUntraced: fn.Untraced = internal.fnUntraced

/**
 * Creates a traced function with an optional span name and `SpanOptionsNoTrace` that adds spans and stack frames, plus pipeable post-processing that receives the Effect and the original arguments.
 *
 * **Details**
 *
 * Pipeable functions run after the body and can transform the resulting Effect.
 *
 * **Example** (Defining traced effect functions)
 *
 * ```ts
 * import { Console, Effect } from "effect"
 *
 * // Create a named span and post-process the returned Effect.
 * const greet = Effect.fn("greet")(
 *   function*(name: string) {
 *     yield* Console.log(`Hello, ${name}`)
 *     return name.length
 *   },
 *   Effect.map((length) => length + 1)
 * )
 *
 * const program = Effect.gen(function*() {
 *   const result = yield* greet("Ada")
 *   yield* Console.log(`Length: ${result}`)
 * })
 * ```
 *
 * @category functions
 * @since 3.11.0
 */
export const fn: fn.Traced & {
  (name: string, options?: SpanOptionsNoTrace): fn.Traced
} = internal.fn

// ========================================================================
// Clock
// ========================================================================

/**
 * Retrieves the `Clock` service from the context and provides it to the
 * specified effectful function.
 *
 * **Example** (Accessing the Clock service)
 *
 * ```ts
 * import { Console, Effect } from "effect"
 *
 * const program = Effect.clockWith((clock) =>
 *   clock.currentTimeMillis.pipe(
 *     Effect.map((currentTime) => `Current time is: ${currentTime}`),
 *     Effect.tap(Console.log)
 *   )
 * )
 *
 * Effect.runFork(program)
 * // Example Output:
 * // Current time is: 1735484929744
 * ```
 *
 * @category clock
 * @since 2.0.0
 */
export const clockWith: <A, E, R>(
  f: (clock: Clock) => Effect<A, E, R>
) => Effect<A, E, R> = internal.clockWith

// ========================================================================
// Logging
// ========================================================================

/**
 * Creates a logger function that logs at the specified level.
 *
 * **Details**
 *
 * If no level is provided, the logger uses the fiber's current log level and
 * extracts any `Cause` values from the message list.
 *
 * **Example** (Logging at a dynamic level)
 *
 * ```ts
 * import { Effect } from "effect"
 *
 * const logWarn = Effect.logWithLevel("Warn")
 *
 * const program = Effect.gen(function*() {
 *   yield* logWarn("Cache miss", { key: "user:1" })
 * })
 * ```
 *
 * @category logging
 * @since 2.0.0
 */
export const logWithLevel: (level?: Severity) => (...message: ReadonlyArray<any>) => Effect<void> =
  internal.logWithLevel

/**
 * Logs one or more messages using the default log level.
 *
 * **Example** (Logging at the default level)
 *
 * ```ts
 * import { Effect } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   yield* Effect.log("Starting computation")
 *   const result = 2 + 2
 *   yield* Effect.log("Result:", result)
 *   yield* Effect.log("Multiple", "values", "can", "be", "logged")
 *   return result
 * })
 *
 * Effect.runPromise(program).then(console.log)
 * // Output:
 * // timestamp=2023-... level=INFO message="Starting computation"
 * // timestamp=2023-... level=INFO message="Result: 4"
 * // timestamp=2023-... level=INFO message="Multiple values can be logged"
 * // 4
 * ```
 *
 * @category logging
 * @since 2.0.0
 */
export const log: (...message: ReadonlyArray<any>) => Effect<void> = internal.logWithLevel()

/**
 * Logs one or more messages at the FATAL level.
 *
 * **Example** (Logging fatal messages)
 *
 * ```ts
 * import { Effect } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   try {
 *     // Simulate a critical system failure
 *     throw new Error("System memory exhausted")
 *   } catch (error) {
 *     const errorMessage = error instanceof Error ? error.message : String(error)
 *     yield* Effect.logFatal("Critical system failure:", errorMessage)
 *     yield* Effect.logFatal("System shutting down")
 *   }
 * })
 *
 * Effect.runPromise(program)
 * // Output:
 * // timestamp=2023-... level=FATAL message="Critical system failure: System memory exhausted"
 * // timestamp=2023-... level=FATAL message="System shutting down"
 * ```
 *
 * @category logging
 * @since 2.0.0
 */
export const logFatal: (...message: ReadonlyArray<any>) => Effect<void> = internal.logWithLevel("Fatal")

/**
 * Logs one or more messages at the WARNING level.
 *
 * **Example** (Logging warnings)
 *
 * ```ts
 * import { Effect } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   yield* Effect.logWarning("API rate limit approaching")
 *   yield* Effect.logWarning("Retries remaining:", 2, "Operation:", "fetchData")
 *
 *   // Useful for non-critical issues
 *   const deprecated = true
 *   if (deprecated) {
 *     yield* Effect.logWarning("Using deprecated API endpoint")
 *   }
 * })
 *
 * Effect.runPromise(program)
 * // Output:
 * // timestamp=2023-... level=WARN message="API rate limit approaching"
 * // timestamp=2023-... level=WARN message="Retries remaining: 2 Operation: fetchData"
 * // timestamp=2023-... level=WARN message="Using deprecated API endpoint"
 * ```
 *
 * @category logging
 * @since 2.0.0
 */
export const logWarning: (...message: ReadonlyArray<any>) => Effect<void> = internal.logWithLevel("Warn")

/**
 * Logs one or more messages at the ERROR level.
 *
 * **Example** (Logging errors)
 *
 * ```ts
 * import { Effect } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   yield* Effect.logError("Database connection failed")
 *   yield* Effect.logError(
 *     "Error code:",
 *     500,
 *     "Message:",
 *     "Internal server error"
 *   )
 *
 *   // Can be used with error objects
 *   const error = new Error("Something went wrong")
 *   yield* Effect.logError("Caught error:", error.message)
 * })
 *
 * Effect.runPromise(program)
 * // Output:
 * // timestamp=2023-... level=ERROR message="Database connection failed"
 * // timestamp=2023-... level=ERROR message="Error code: 500 Message: Internal server error"
 * // timestamp=2023-... level=ERROR message="Caught error: Something went wrong"
 * ```
 *
 * @category logging
 * @since 2.0.0
 */
export const logError: (...message: ReadonlyArray<any>) => Effect<void> = internal.logWithLevel("Error")

/**
 * Logs one or more messages at the INFO level.
 *
 * **Example** (Logging information)
 *
 * ```ts
 * import { Effect } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   yield* Effect.logInfo("Application starting up")
 *   yield* Effect.logInfo("Config loaded:", "production", "Port:", 3000)
 *
 *   // Useful for general information
 *   const version = "1.2.3"
 *   yield* Effect.logInfo("Application version:", version)
 * })
 *
 * Effect.runPromise(program)
 * // Output:
 * // timestamp=2023-... level=INFO message="Application starting up"
 * // timestamp=2023-... level=INFO message="Config loaded: production Port: 3000"
 * // timestamp=2023-... level=INFO message="Application version: 1.2.3"
 * ```
 *
 * @category logging
 * @since 2.0.0
 */
export const logInfo: (...message: ReadonlyArray<any>) => Effect<void> = internal.logWithLevel("Info")

/**
 * Logs one or more messages at the DEBUG level.
 *
 * **Example** (Logging debug messages)
 *
 * ```ts
 * import { Effect } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   yield* Effect.logDebug("Debug mode enabled")
 *
 *   const userInput = { name: "Alice", age: 30 }
 *   yield* Effect.logDebug("Processing user input:", userInput)
 *
 *   // Useful for detailed diagnostic information
 *   yield* Effect.logDebug("Variable state:", "x=10", "y=20", "z=30")
 * })
 *
 * Effect.runPromise(program)
 * // Output:
 * // timestamp=2023-... level=DEBUG message="Debug mode enabled"
 * // timestamp=2023-... level=DEBUG message="Processing user input: [object Object]"
 * // timestamp=2023-... level=DEBUG message="Variable state: x=10 y=20 z=30"
 * ```
 *
 * @category logging
 * @since 2.0.0
 */
export const logDebug: (...message: ReadonlyArray<any>) => Effect<void> = internal.logWithLevel("Debug")

/**
 * Logs one or more messages at the TRACE level.
 *
 * **Example** (Logging trace messages)
 *
 * ```ts
 * import { Effect } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   yield* Effect.logTrace("Entering function processData")
 *
 *   // Trace detailed execution flow
 *   for (let i = 0; i < 3; i++) {
 *     yield* Effect.logTrace("Loop iteration:", i, "Processing item")
 *   }
 *
 *   yield* Effect.logTrace("Exiting function processData")
 * })
 *
 * Effect.runPromise(program)
 * // Output:
 * // timestamp=2023-... level=TRACE message="Entering function processData"
 * // timestamp=2023-... level=TRACE message="Loop iteration: 0 Processing item"
 * // timestamp=2023-... level=TRACE message="Loop iteration: 1 Processing item"
 * // timestamp=2023-... level=TRACE message="Loop iteration: 2 Processing item"
 * // timestamp=2023-... level=TRACE message="Exiting function processData"
 * ```
 *
 * @category logging
 * @since 2.0.0
 */
export const logTrace: (...message: ReadonlyArray<any>) => Effect<void> = internal.logWithLevel("Trace")

/**
 * Adds a logger to the set of loggers which will output logs for this effect.
 *
 * **Example** (Adding a logger to an effect)
 *
 * ```ts
 * import { Effect, Logger } from "effect"
 *
 * // Create a custom logger that logs to the console
 * const customLogger = Logger.make(({ message }) =>
 *   Effect.sync(() => console.log(`[CUSTOM]: ${message}`))
 * )
 *
 * const program = Effect.gen(function*() {
 *   yield* Effect.log("This will go to both default and custom logger")
 *   return "completed"
 * })
 *
 * // Add the custom logger to the effect
 * const programWithLogger = Effect.withLogger(program, customLogger)
 *
 * Effect.runPromise(programWithLogger)
 * // Output includes both default and custom log outputs
 * ```
 *
 * @category logging
 * @since 4.0.0
 */
export const withLogger = dual<
  <Output>(
    logger: Logger<unknown, Output>
  ) => <A, E, R>(effect: Effect<A, E, R>) => Effect<A, E, R>,
  <A, E, R, Output>(
    effect: Effect<A, E, R>,
    logger: Logger<unknown, Output>
  ) => Effect<A, E, R>
>(2, (effect, logger) =>
  internal.updateService(
    effect,
    internal.CurrentLoggers,
    (loggers) => new Set([...loggers, logger])
  ))

/**
 * Adds an annotation to each log line in this effect.
 *
 * **Example** (Adding log annotations)
 *
 * ```ts
 * import { Effect } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   yield* Effect.log("Starting operation")
 *   yield* Effect.log("Processing data")
 *   yield* Effect.log("Operation completed")
 * })
 *
 * // Add annotations to all log messages
 * const annotatedProgram = Effect.annotateLogs(program, {
 *   userId: "user123",
 *   operation: "data-processing"
 * })
 *
 * // Also supports single key-value annotations
 * const singleAnnotated = Effect.annotateLogs(program, "requestId", "req-456")
 *
 * Effect.runPromise(annotatedProgram)
 * // All log messages will include the userId and operation annotations
 * ```
 *
 * @category logging
 * @since 2.0.0
 */
export const annotateLogs = dual<
  {
    (
      key: string,
      value: unknown
    ): <A, E, R>(effect: Effect<A, E, R>) => Effect<A, E, R>
    (
      values: Record<string, unknown>
    ): <A, E, R>(effect: Effect<A, E, R>) => Effect<A, E, R>
  },
  {
    <A, E, R>(
      effect: Effect<A, E, R>,
      key: string,
      value: unknown
    ): Effect<A, E, R>
    <A, E, R>(
      effect: Effect<A, E, R>,
      values: Record<string, unknown>
    ): Effect<A, E, R>
  }
>(
  (args) => isEffect(args[0]),
  <A, E, R>(
    effect: Effect<A, E, R>,
    ...args: [Record<string, unknown>] | [key: string, value: unknown]
  ): Effect<A, E, R> =>
    internal.updateService(effect, CurrentLogAnnotations, (annotations) => {
      const newAnnotations = { ...annotations }
      if (args.length === 1) {
        Object.assign(newAnnotations, args[0])
      } else {
        newAnnotations[args[0]] = args[1]
      }
      return newAnnotations
    })
)

/**
 * Adds log annotations to the current scope.
 *
 * **When to use**
 *
 * Use to attach log annotations that last until the current scope closes.
 *
 * **Details**
 *
 * This differs from `annotateLogs`, which only annotates a specific effect.
 * `annotateLogsScoped` updates annotations for the entire current `Scope` and
 * restores the previous annotations when the scope closes.
 *
 * **Example** (Adding scoped log annotations)
 *
 * ```ts
 * import { Effect } from "effect"
 *
 * const program = Effect.scoped(
 *   Effect.gen(function*() {
 *     yield* Effect.log("before")
 *     yield* Effect.annotateLogsScoped({ requestId: "req-123" })
 *     yield* Effect.log("inside scope")
 *   })
 * )
 *
 * Effect.runPromise(program)
 * ```
 *
 * @see {@link annotateLogs} for annotating one effect
 *
 * @category logging
 * @since 3.1.0
 */
export const annotateLogsScoped: {
  (key: string, value: unknown): Effect<void, never, Scope>
  (values: Record<string, unknown>): Effect<void, never, Scope>
} = internal.annotateLogsScoped

/**
 * Adds a span to each log line in this effect.
 *
 * **Example** (Adding a log span)
 *
 * ```ts
 * import { Effect } from "effect"
 *
 * const databaseOperation = Effect.gen(function*() {
 *   yield* Effect.log("Connecting to database")
 *   yield* Effect.log("Executing query")
 *   yield* Effect.log("Processing results")
 *   return "data"
 * })
 *
 * const httpRequest = Effect.gen(function*() {
 *   yield* Effect.log("Making HTTP request")
 *   const data = yield* Effect.withLogSpan(databaseOperation, "db-operation")
 *   yield* Effect.log("Sending response")
 *   return data
 * })
 *
 * const program = Effect.withLogSpan(httpRequest, "http-handler")
 *
 * Effect.runPromise(program)
 * // All log messages will include span information showing the nested operation context
 * ```
 *
 * @category logging
 * @since 2.0.0
 */
export const withLogSpan = dual<
  (label: string) => <A, E, R>(effect: Effect<A, E, R>) => Effect<A, E, R>,
  <A, E, R>(effect: Effect<A, E, R>, label: string) => Effect<A, E, R>
>(
  2,
  (effect, label) =>
    internal.flatMap(internal.currentTimeMillis, (now) =>
      internal.updateService(effect, CurrentLogSpans, (spans) => {
        const span: [label: string, timestamp: number] = [label, now]
        return [span, ...spans]
      }))
)

// -----------------------------------------------------------------------------
// Metrics
// -----------------------------------------------------------------------------

/**
 * Updates the `Metric` every time the `Effect` is executed.
 *
 * **Details**
 *
 * Also accepts an optional function which can be used to map the `Exit` value
 * of the `Effect` into a valid `Input` for the `Metric`.
 *
 * **Example** (Incrementing a metric for each execution)
 *
 * ```ts
 * import { Effect, Metric } from "effect"
 *
 * const counter = Metric.counter("effect_executions", {
 *   description: "Counts effect executions"
 * }).pipe(Metric.withConstantInput(1))
 *
 * const program = Effect.succeed("Hello").pipe(
 *   Effect.track(counter)
 * )
 *
 * // This will increment the counter by 1 when executed
 * Effect.runPromise(program).then(() =>
 *   Effect.runPromise(Metric.value(counter)).then(console.log)
 *   // Output: { count: 1, incremental: false }
 * )
 * ```
 *
 * **Example** (Mapping exits before updating a metric)
 *
 * ```ts
 * import { Effect, Exit, Metric } from "effect"
 *
 * // Track different exit types with custom mapping
 * const exitTracker = Metric.frequency("exit_types", {
 *   description: "Tracks success/failure/defect counts"
 * })
 *
 * const mapExitToString = (exit: Exit.Exit<string, Error>) => {
 *   if (Exit.isSuccess(exit)) return "success"
 *   if (Exit.isFailure(exit)) return "failure"
 *   return "defect"
 * }
 *
 * const effect = Effect.succeed("result").pipe(
 *   Effect.track(exitTracker, mapExitToString)
 * )
 * ```
 *
 * @category tracking
 * @since 4.0.0
 */
export const track: {
  <Input, State, E, A>(
    metric: Metric.Metric<Input, State>,
    f: (exit: Exit.Exit<A, E>) => Input
  ): <E, R>(self: Effect<A, E, R>) => Effect<A, E, R>
  <State, E, A>(
    metric: Metric.Metric<Exit.Exit<NoInfer<A>, NoInfer<E>>, State>
  ): <R>(self: Effect<A, E, R>) => Effect<A, E, R>
  <A, E, R, Input, State>(
    self: Effect<A, E, R>,
    metric: Metric.Metric<Input, State>,
    f: (exit: Exit.Exit<A, E>) => Input
  ): Effect<A, E, R>
  <A, E, R, State>(
    self: Effect<A, E, R>,
    metric: Metric.Metric<Exit.Exit<NoInfer<A>, NoInfer<E>>, State>
  ): Effect<A, E, R>
} = dual(
  (args) => isEffect(args[0]),
  <A, E, R, Input, State>(
    self: Effect<A, E, R>,
    metric: Metric.Metric<Input, State>,
    f: (exit: Exit.Exit<A, E>) => Input
  ): Effect<A, E, R> =>
    onExit(self, (exit) => {
      const input = f === undefined ? exit : internalCall(() => f(exit))
      return Metric.update(metric, input as any)
    })
)

/**
 * Updates the provided `Metric` every time the wrapped `Effect` succeeds with
 * a value.
 *
 * **Details**
 *
 * Also accepts an optional function which can be used to map the success value
 * of the `Effect` into a valid `Input` for the `Metric`.
 *
 * **Example** (Counting successful results)
 *
 * ```ts
 * import { Effect, Metric } from "effect"
 *
 * const successCounter = Metric.counter("successes").pipe(
 *   Metric.withConstantInput(1)
 * )
 *
 * const program = Effect.succeed(42).pipe(
 *   Effect.trackSuccesses(successCounter)
 * )
 *
 * Effect.runPromise(program).then(() =>
 *   Effect.runPromise(Metric.value(successCounter)).then(console.log)
 *   // Output: { count: 1, incremental: false }
 * )
 * ```
 *
 * **Example** (Mapping successes before tracking)
 *
 * ```ts
 * import { Effect, Metric } from "effect"
 *
 * // Track successful request sizes
 * const requestSizeGauge = Metric.gauge("request_size_bytes")
 *
 * const program = Effect.succeed("Hello World!").pipe(
 *   Effect.trackSuccesses(requestSizeGauge, (value: string) => value.length)
 * )
 *
 * Effect.runPromise(program).then(() =>
 *   Effect.runPromise(Metric.value(requestSizeGauge)).then(console.log)
 *   // Output: { value: 12 }
 * )
 * ```
 *
 * @category tracking
 * @since 4.0.0
 */
export const trackSuccesses: {
  <Input, State, A>(
    metric: Metric.Metric<Input, State>,
    f: (value: A) => Input
  ): <E, R>(self: Effect<A, E, R>) => Effect<A, E, R>
  <State, A>(
    metric: Metric.Metric<NoInfer<A>, State>
  ): <E, R>(self: Effect<A, E, R>) => Effect<A, E, R>
  <A, E, R, Input, State>(
    self: Effect<A, E, R>,
    metric: Metric.Metric<Input, State>,
    f: (value: A) => Input
  ): Effect<A, E, R>
  <A, E, R, State>(
    self: Effect<A, E, R>,
    metric: Metric.Metric<NoInfer<A>, State>
  ): Effect<A, E, R>
} = dual(
  (args) => isEffect(args[0]),
  <A, E, R, Input, State>(
    self: Effect<A, E, R>,
    metric: Metric.Metric<Input, State>,
    f: ((value: A) => Input) | undefined
  ): Effect<A, E, R> =>
    tap(self, (value) => {
      const input = f === undefined ? value : f(value)
      return Metric.update(metric, input as any)
    })
)

/**
 * Updates the provided `Metric` every time the wrapped `Effect` fails with an
 * **expected** error.
 *
 * **Details**
 *
 * Also accepts an optional function which can be used to map the error value
 * of the `Effect` into a valid `Input` for the `Metric`.
 *
 * **Example** (Counting expected failures)
 *
 * ```ts
 * import { Effect, Metric } from "effect"
 *
 * const errorCounter = Metric.counter("errors").pipe(
 *   Metric.withConstantInput(1)
 * )
 *
 * const program = Effect.fail("Network timeout").pipe(
 *   Effect.trackErrors(errorCounter)
 * )
 *
 * Effect.runPromiseExit(program).then(() =>
 *   Effect.runPromise(Metric.value(errorCounter)).then(console.log)
 *   // Output: { count: 1, incremental: false }
 * )
 * ```
 *
 * **Example** (Mapping errors before tracking)
 *
 * ```ts
 * import { Data, Effect, Metric } from "effect"
 *
 * class ConnectionFailedError extends Data.TaggedError("ConnectionFailedError")<{}> {}
 *
 * // Track error types using frequency metric
 * const errorTypeFrequency = Metric.frequency("error_types")
 *
 * const program = Effect.fail(new ConnectionFailedError()).pipe(
 *   Effect.trackErrors(errorTypeFrequency, (error: ConnectionFailedError) => error._tag)
 * )
 *
 * Effect.runPromiseExit(program).then(() =>
 *   Effect.runPromise(Metric.value(errorTypeFrequency)).then(console.log)
 *   // Output: { occurrences: Map(1) { "ConnectionFailedError" => 1 } }
 * )
 * ```
 *
 * @category tracking
 * @since 4.0.0
 */
export const trackErrors: {
  <Input, State, E>(
    metric: Metric.Metric<Input, State>,
    f: (error: E) => Input
  ): <A, R>(self: Effect<A, E, R>) => Effect<A, E, R>
  <State, E>(
    metric: Metric.Metric<NoInfer<E>, State>
  ): <A, R>(self: Effect<A, E, R>) => Effect<A, E, R>
  <A, E, R, Input, State>(
    self: Effect<A, E, R>,
    metric: Metric.Metric<Input, State>,
    f: (error: E) => Input
  ): Effect<A, E, R>
  <A, E, R, State>(
    self: Effect<A, E, R>,
    metric: Metric.Metric<NoInfer<E>, State>
  ): Effect<A, E, R>
} = dual(
  (args) => isEffect(args[0]),
  <A, E, R, Input, State>(
    self: Effect<A, E, R>,
    metric: Metric.Metric<Input, State>,
    f: ((error: E) => Input) | undefined
  ): Effect<A, E, R> =>
    tapError(self, (error) => {
      const input = f === undefined ? error : internalCall(() => f(error))
      return Metric.update(metric, input as any)
    })
)

/**
 * Updates the provided `Metric` every time the wrapped `Effect` fails with an
 * **unexpected** error (i.e. a defect).
 *
 * **Details**
 *
 * Also accepts an optional function which can be used to map the defect value
 * of the `Effect` into a valid `Input` for the `Metric`.
 *
 * **Example** (Counting defects)
 *
 * ```ts
 * import { Effect, Metric } from "effect"
 *
 * const defectCounter = Metric.counter("defects").pipe(
 *   Metric.withConstantInput(1)
 * )
 *
 * const program = Effect.die("Critical system failure").pipe(
 *   Effect.trackDefects(defectCounter)
 * )
 *
 * Effect.runPromiseExit(program).then(() =>
 *   Effect.runPromise(Metric.value(defectCounter)).then(console.log)
 *   // Output: { count: 1, incremental: false }
 * )
 * ```
 *
 * **Example** (Mapping defects before tracking)
 *
 * ```ts
 * import { Effect, Metric } from "effect"
 *
 * // Track defect types using frequency metric
 * const defectTypeFrequency = Metric.frequency("defect_types")
 *
 * const program = Effect.die(new Error("Null pointer exception")).pipe(
 *   Effect.trackDefects(defectTypeFrequency, (defect: unknown) => {
 *     if (defect instanceof Error) return defect.constructor.name
 *     return typeof defect
 *   })
 * )
 *
 * Effect.runPromiseExit(program).then(() =>
 *   Effect.runPromise(Metric.value(defectTypeFrequency)).then(console.log)
 *   // Output: { occurrences: Map(1) { "Error" => 1 } }
 * )
 * ```
 *
 * @category tracking
 * @since 4.0.0
 */
export const trackDefects: {
  <Input, State>(
    metric: Metric.Metric<Input, State>,
    f: (defect: unknown) => Input
  ): <A, E, R>(self: Effect<A, E, R>) => Effect<A, E, R>
  <State, E>(
    metric: Metric.Metric<unknown, State>
  ): <A, R>(self: Effect<A, E, R>) => Effect<A, E, R>
  <A, E, R, Input, State>(
    self: Effect<A, E, R>,
    metric: Metric.Metric<Input, State>,
    f: (defect: unknown) => Input
  ): Effect<A, E, R>
  <A, E, R, State>(
    self: Effect<A, E, R>,
    metric: Metric.Metric<unknown, State>
  ): Effect<A, E, R>
} = dual(
  (args) => isEffect(args[0]),
  (self, metric, f) =>
    tapDefect(self, (defect) => {
      const input = f === undefined ? defect : internalCall(() => f(defect))
      return Metric.update(metric, input)
    })
)

/**
 * Updates the provided `Metric` with the `Duration` of time (in nanoseconds)
 * that the wrapped `Effect` took to complete.
 *
 * **Details**
 *
 * Also accepts an optional function which can be used to map the `Duration`
 * that the wrapped `Effect` took to complete into a valid `Input` for the
 * `Metric`.
 *
 * **Example** (Recording execution duration)
 *
 * ```ts
 * import { Effect, Metric } from "effect"
 *
 * const executionTimer = Metric.timer("execution_time")
 *
 * const program = Effect.sleep("100 millis").pipe(
 *   Effect.trackDuration(executionTimer)
 * )
 *
 * Effect.runPromise(program).then(() =>
 *   Effect.runPromise(Metric.value(executionTimer)).then(console.log)
 *   // Output: { count: 1, min: 100000000, max: 100000000, sum: 100000000 }
 * )
 * ```
 *
 * **Example** (Mapping duration before tracking)
 *
 * ```ts
 * import { Duration, Effect, Metric } from "effect"
 *
 * // Track execution time in milliseconds using custom mapping
 * const durationGauge = Metric.gauge("execution_millis")
 *
 * const program = Effect.sleep("200 millis").pipe(
 *   Effect.trackDuration(durationGauge, (duration) => Duration.toMillis(duration))
 * )
 *
 * Effect.runPromise(program).then(() =>
 *   Effect.runPromise(Metric.value(durationGauge)).then(console.log)
 *   // Output: { value: 200 }
 * )
 * ```
 *
 * @category tracking
 * @since 4.0.0
 */
export const trackDuration: {
  <Input, State>(
    metric: Metric.Metric<Input, State>,
    f: (duration: Duration.Duration) => Input
  ): <A, E, R>(self: Effect<A, E, R>) => Effect<A, E, R>
  <State, E>(
    metric: Metric.Metric<Duration.Duration, State>
  ): <A, R>(self: Effect<A, E, R>) => Effect<A, E, R>
  <A, E, R, Input, State>(
    self: Effect<A, E, R>,
    metric: Metric.Metric<Input, State>,
    f: (duration: Duration.Duration) => Input
  ): Effect<A, E, R>
  <A, E, R, State>(
    self: Effect<A, E, R>,
    metric: Metric.Metric<Duration.Duration, State>
  ): Effect<A, E, R>
} = dual(
  (args) => isEffect(args[0]),
  <A, E, R, Input, State>(
    self: Effect<A, E, R>,
    metric: Metric.Metric<Input, State>,
    f: ((duration: Duration.Duration) => Input) | undefined
  ): Effect<A, E, R> =>
    clockWith((clock) => {
      const startTime = clock.currentTimeNanosUnsafe()
      return onExit(self, () => {
        const endTime = clock.currentTimeNanosUnsafe()
        const duration = Duration.subtract(
          Duration.fromInputUnsafe(endTime),
          Duration.fromInputUnsafe(startTime)
        )
        const input = f === undefined ? duration : internalCall(() => f(duration))
        return Metric.update(metric, input as any)
      })
    })
)

// -----------------------------------------------------------------------------
// Transactions
// -----------------------------------------------------------------------------

/**
 * Service that holds the current transaction state.
 *
 * **Details**
 *
 * It includes a journal that stores non-committed changes to `TxRef` values and
 * a retry flag that records whether the transaction should be retried.
 *
 * **Example** (Building transactions)
 *
 * ```ts
 * import { Effect } from "effect"
 *
 * // Transaction class for software transactional memory operations
 * const txEffect = Effect.gen(function*() {
 *   const tx = yield* Effect.Transaction
 *   // Use transaction for coordinated state changes
 *   return "Transaction complete"
 * })
 * ```
 *
 * @category transactions
 * @since 4.0.0
 */
export class Transaction extends Context.Service<
  Transaction,
  {
    retry: boolean
    readonly journal: Map<
      TxRef<any>,
      {
        readonly version: number
        value: any
      }
    >
  }
>()("effect/Effect/Transaction") {}

/**
 * Defines a transaction boundary. Transactions are "all or nothing" with respect to changes
 * made to transactional values (i.e. TxRef) that occur within the transaction body.
 *
 * **Details**
 *
 * If called inside an active transaction, `tx` composes with the current transaction and reuses
 * its journal and retry state instead of creating a nested boundary.
 *
 * In Effect transactions are optimistic with retry, that means transactions are retried when:
 *
 * - the body of the transaction explicitely calls to `Effect.txRetry` and any of the
 *   accessed transactional values changes.
 *
 * - any of the accessed transactional values change during the execution of the transaction
 *   due to a different transaction committing before the current.
 *
 * The outermost `tx` call creates the transaction boundary and commits or rolls back the full
 * composed transaction.
 *
 * **Example** (Running a transaction)
 *
 * ```ts
 * import { Effect, TxRef } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const ref1 = yield* TxRef.make(0)
 *   const ref2 = yield* TxRef.make(0)
 *
 *   // Nested tx calls compose into the same transaction
 *   yield* Effect.tx(Effect.gen(function*() {
 *     yield* TxRef.set(ref1, 10)
 *     yield* Effect.tx(TxRef.set(ref2, 20))
 *     const sum = (yield* TxRef.get(ref1)) + (yield* TxRef.get(ref2))
 *     console.log(`Transaction sum: ${sum}`)
 *   }))
 *
 *   console.log(`Final ref1: ${yield* TxRef.get(ref1)}`) // 10
 *   console.log(`Final ref2: ${yield* TxRef.get(ref2)}`) // 20
 * })
 * ```
 *
 * @category transactions
 * @since 4.0.0
 */
export const tx = <A, E, R>(
  effect: Effect<A, E, R>
): Effect<A, E, Exclude<R, Transaction>> =>
  withFiber((fiber) => {
    if (fiber.context.mapUnsafe.has(Transaction.key)) {
      return effect as Effect<A, E, Exclude<R, Transaction>>
    }
    // Create transaction state only at the outermost boundary
    const state: Transaction["Service"] = { journal: new Map(), retry: false }
    let result: Exit.Exit<A, E> | undefined
    return uninterruptibleMask((restore) =>
      flatMap(
        whileLoop({
          while: () => !result,
          body: constant(
            restore(effect).pipe(
              provideService(Transaction, state),
              tapCause(() => {
                if (!state.retry) return void_
                return restore(awaitPendingTransaction(state))
              }),
              exit
            )
          ),
          step(exit: Exit.Exit<A, E>) {
            if (state.retry || !isTransactionConsistent(state)) {
              return clearTransaction(state)
            }
            if (Exit.isSuccess(exit)) {
              commitTransaction(fiber, state)
            } else {
              clearTransaction(state)
            }
            result = exit
          }
        }),
        () => result!
      )
    )
  })

const isTransactionConsistent = (state: Transaction["Service"]) => {
  for (const [ref, { version }] of state.journal) {
    if (ref.version !== version) {
      return false
    }
  }
  return true
}

const awaitPendingTransaction = (state: Transaction["Service"]) =>
  suspend(() => {
    const key = {}
    const refs = Array.from(state.journal.keys())
    const clearPending = () => {
      for (const clear of refs) {
        clear.pending.delete(key)
      }
    }
    return callback<void>((resume) => {
      const onCall = () => {
        clearPending()
        resume(void_)
      }
      for (const ref of refs) {
        ref.pending.set(key, onCall)
      }
      return sync(clearPending)
    })
  })

function commitTransaction(fiber: Fiber<unknown, unknown>, state: Transaction["Service"]) {
  for (const [ref, { value }] of state.journal) {
    if (value !== ref.value) {
      ref.version = ref.version + 1
      ref.value = value
    }
    for (const pending of ref.pending.values()) {
      fiber.currentDispatcher.scheduleTask(pending, 0)
    }
    ref.pending.clear()
  }
}

function clearTransaction(state: Transaction["Service"]) {
  state.retry = false
  state.journal.clear()
}

/**
 * Retries the current transaction by signaling that it must be retried.
 *
 * **Details**
 *
 * NOTE: the transaction retries on any change to transactional values (i.e. TxRef) accessed in its body.
 *
 * **Example** (Retrying transactions)
 *
 * ```ts
 * import { Effect, TxRef } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   // create a transactional reference
 *   const ref = yield* TxRef.make(0)
 *
 *   // forks a fiber that increases the value of `ref` every 100 millis
 *   yield* Effect.forkChild(Effect.forever(
 *     // update to transactional value
 *     Effect.tx(TxRef.update(ref, (n) => n + 1)).pipe(Effect.delay("100 millis"))
 *   ))
 *
 *   // the following will retry 10 times until the `ref` value is 10
 *   yield* Effect.tx(Effect.gen(function*() {
 *     const value = yield* TxRef.get(ref)
 *     if (value < 10) {
 *       yield* Effect.log(`retry due to value: ${value}`)
 *       return yield* Effect.txRetry
 *     }
 *     yield* Effect.log(`transaction done with value: ${value}`)
 *   }))
 * })
 *
 * Effect.runPromise(program).catch(console.error)
 * ```
 *
 * @category transactions
 * @since 4.0.0
 */
export const txRetry: Effect<never, never, Transaction> = flatMap(
  Transaction,
  (state) => {
    state.retry = true
    return interrupt
  }
)
/**
 * Type helpers for converting callback-based functions into `Effect` functions.
 *
 * @since 4.0.0
 */
export declare namespace Effectify {
  interface Callback<E, A> {
    (err: E, a?: A): void
  }

  type ArgsWithCallback<Args extends Array<any>, E, A> = [...args: Args, cb: Callback<E, A>]

  type WithoutNull<A> = unknown extends A ? void : Exclude<A, null | undefined>

  /**
   * Converts a callback-based function type into an `Effect`-returning function type.
   *
   * @category effectify
   * @since 4.0.0
   */
  export type Effectify<T, E> = T extends {
    (...args: ArgsWithCallback<infer Args1, infer _E1, infer A1>): infer _R1
    (...args: ArgsWithCallback<infer Args2, infer _E2, infer A2>): infer _R2
    (...args: ArgsWithCallback<infer Args3, infer _E3, infer A3>): infer _R3
    (...args: ArgsWithCallback<infer Args4, infer _E4, infer A4>): infer _R4
    (...args: ArgsWithCallback<infer Args5, infer _E5, infer A5>): infer _R5
    (...args: ArgsWithCallback<infer Args6, infer _E6, infer A6>): infer _R6
    (...args: ArgsWithCallback<infer Args7, infer _E7, infer A7>): infer _R7
    (...args: ArgsWithCallback<infer Args8, infer _E8, infer A8>): infer _R8
    (...args: ArgsWithCallback<infer Args9, infer _E9, infer A9>): infer _R9
    (...args: ArgsWithCallback<infer Args10, infer _E10, infer A10>): infer _R10
  } ? {
      (...args: Args1): Effect<WithoutNull<A1>, E>
      (...args: Args2): Effect<WithoutNull<A2>, E>
      (...args: Args3): Effect<WithoutNull<A3>, E>
      (...args: Args4): Effect<WithoutNull<A4>, E>
      (...args: Args5): Effect<WithoutNull<A5>, E>
      (...args: Args6): Effect<WithoutNull<A6>, E>
      (...args: Args7): Effect<WithoutNull<A7>, E>
      (...args: Args8): Effect<WithoutNull<A8>, E>
      (...args: Args9): Effect<WithoutNull<A9>, E>
      (...args: Args10): Effect<WithoutNull<A10>, E>
    }
    : T extends {
      (...args: ArgsWithCallback<infer Args1, infer _E1, infer A1>): infer _R1
      (...args: ArgsWithCallback<infer Args2, infer _E2, infer A2>): infer _R2
      (...args: ArgsWithCallback<infer Args3, infer _E3, infer A3>): infer _R3
      (...args: ArgsWithCallback<infer Args4, infer _E4, infer A4>): infer _R4
      (...args: ArgsWithCallback<infer Args5, infer _E5, infer A5>): infer _R5
      (...args: ArgsWithCallback<infer Args6, infer _E6, infer A6>): infer _R6
      (...args: ArgsWithCallback<infer Args7, infer _E7, infer A7>): infer _R7
      (...args: ArgsWithCallback<infer Args8, infer _E8, infer A8>): infer _R8
      (...args: ArgsWithCallback<infer Args9, infer _E9, infer A9>): infer _R9
    } ? {
        (...args: Args1): Effect<WithoutNull<A1>, E>
        (...args: Args2): Effect<WithoutNull<A2>, E>
        (...args: Args3): Effect<WithoutNull<A3>, E>
        (...args: Args4): Effect<WithoutNull<A4>, E>
        (...args: Args5): Effect<WithoutNull<A5>, E>
        (...args: Args6): Effect<WithoutNull<A6>, E>
        (...args: Args7): Effect<WithoutNull<A7>, E>
        (...args: Args8): Effect<WithoutNull<A8>, E>
        (...args: Args9): Effect<WithoutNull<A9>, E>
      }
    : T extends {
      (...args: ArgsWithCallback<infer Args1, infer _E1, infer A1>): infer _R1
      (...args: ArgsWithCallback<infer Args2, infer _E2, infer A2>): infer _R2
      (...args: ArgsWithCallback<infer Args3, infer _E3, infer A3>): infer _R3
      (...args: ArgsWithCallback<infer Args4, infer _E4, infer A4>): infer _R4
      (...args: ArgsWithCallback<infer Args5, infer _E5, infer A5>): infer _R5
      (...args: ArgsWithCallback<infer Args6, infer _E6, infer A6>): infer _R6
      (...args: ArgsWithCallback<infer Args7, infer _E7, infer A7>): infer _R7
      (...args: ArgsWithCallback<infer Args8, infer _E8, infer A8>): infer _R8
    } ? {
        (...args: Args1): Effect<WithoutNull<A1>, E>
        (...args: Args2): Effect<WithoutNull<A2>, E>
        (...args: Args3): Effect<WithoutNull<A3>, E>
        (...args: Args4): Effect<WithoutNull<A4>, E>
        (...args: Args5): Effect<WithoutNull<A5>, E>
        (...args: Args6): Effect<WithoutNull<A6>, E>
        (...args: Args7): Effect<WithoutNull<A7>, E>
        (...args: Args8): Effect<WithoutNull<A8>, E>
      }
    : T extends {
      (...args: ArgsWithCallback<infer Args1, infer _E1, infer A1>): infer _R1
      (...args: ArgsWithCallback<infer Args2, infer _E2, infer A2>): infer _R2
      (...args: ArgsWithCallback<infer Args3, infer _E3, infer A3>): infer _R3
      (...args: ArgsWithCallback<infer Args4, infer _E4, infer A4>): infer _R4
      (...args: ArgsWithCallback<infer Args5, infer _E5, infer A5>): infer _R5
      (...args: ArgsWithCallback<infer Args6, infer _E6, infer A6>): infer _R6
      (...args: ArgsWithCallback<infer Args7, infer _E7, infer A7>): infer _R7
    } ? {
        (...args: Args1): Effect<WithoutNull<A1>, E>
        (...args: Args2): Effect<WithoutNull<A2>, E>
        (...args: Args3): Effect<WithoutNull<A3>, E>
        (...args: Args4): Effect<WithoutNull<A4>, E>
        (...args: Args5): Effect<WithoutNull<A5>, E>
        (...args: Args6): Effect<WithoutNull<A6>, E>
        (...args: Args7): Effect<WithoutNull<A7>, E>
      }
    : T extends {
      (...args: ArgsWithCallback<infer Args1, infer _E1, infer A1>): infer _R1
      (...args: ArgsWithCallback<infer Args2, infer _E2, infer A2>): infer _R2
      (...args: ArgsWithCallback<infer Args3, infer _E3, infer A3>): infer _R3
      (...args: ArgsWithCallback<infer Args4, infer _E4, infer A4>): infer _R4
      (...args: ArgsWithCallback<infer Args5, infer _E5, infer A5>): infer _R5
      (...args: ArgsWithCallback<infer Args6, infer _E6, infer A6>): infer _R6
    } ? {
        (...args: Args1): Effect<WithoutNull<A1>, E>
        (...args: Args2): Effect<WithoutNull<A2>, E>
        (...args: Args3): Effect<WithoutNull<A3>, E>
        (...args: Args4): Effect<WithoutNull<A4>, E>
        (...args: Args5): Effect<WithoutNull<A5>, E>
        (...args: Args6): Effect<WithoutNull<A6>, E>
      }
    : T extends {
      (...args: ArgsWithCallback<infer Args1, infer _E1, infer A1>): infer _R1
      (...args: ArgsWithCallback<infer Args2, infer _E2, infer A2>): infer _R2
      (...args: ArgsWithCallback<infer Args3, infer _E3, infer A3>): infer _R3
      (...args: ArgsWithCallback<infer Args4, infer _E4, infer A4>): infer _R4
      (...args: ArgsWithCallback<infer Args5, infer _E5, infer A5>): infer _R5
    } ? {
        (...args: Args1): Effect<WithoutNull<A1>, E>
        (...args: Args2): Effect<WithoutNull<A2>, E>
        (...args: Args3): Effect<WithoutNull<A3>, E>
        (...args: Args4): Effect<WithoutNull<A4>, E>
        (...args: Args5): Effect<WithoutNull<A5>, E>
      }
    : T extends {
      (...args: ArgsWithCallback<infer Args1, infer _E1, infer A1>): infer _R1
      (...args: ArgsWithCallback<infer Args2, infer _E2, infer A2>): infer _R2
      (...args: ArgsWithCallback<infer Args3, infer _E3, infer A3>): infer _R3
      (...args: ArgsWithCallback<infer Args4, infer _E4, infer A4>): infer _R4
    } ? {
        (...args: Args1): Effect<WithoutNull<A1>, E>
        (...args: Args2): Effect<WithoutNull<A2>, E>
        (...args: Args3): Effect<WithoutNull<A3>, E>
        (...args: Args4): Effect<WithoutNull<A4>, E>
      }
    : T extends {
      (...args: ArgsWithCallback<infer Args1, infer _E1, infer A1>): infer _R1
      (...args: ArgsWithCallback<infer Args2, infer _E2, infer A2>): infer _R2
      (...args: ArgsWithCallback<infer Args3, infer _E3, infer A3>): infer _R3
    } ? {
        (...args: Args1): Effect<WithoutNull<A1>, E>
        (...args: Args2): Effect<WithoutNull<A2>, E>
        (...args: Args3): Effect<WithoutNull<A3>, E>
      }
    : T extends {
      (...args: ArgsWithCallback<infer Args1, infer _E1, infer A1>): infer _R1
      (...args: ArgsWithCallback<infer Args2, infer _E2, infer A2>): infer _R2
    } ? {
        (...args: Args1): Effect<WithoutNull<A1>, E>
        (...args: Args2): Effect<WithoutNull<A2>, E>
      }
    : T extends {
      (...args: ArgsWithCallback<infer Args1, infer _E1, infer A1>): infer _R1
    } ? {
        (...args: Args1): Effect<WithoutNull<A1>, E>
      }
    : never

  /**
   * Extracts the callback error type from a callback-based function type.
   *
   * @category utils
   * @since 4.0.0
   */
  export type EffectifyError<T> = T extends {
    (...args: ArgsWithCallback<infer _Args1, infer E1, infer _A1>): infer _R1
    (...args: ArgsWithCallback<infer _Args2, infer E2, infer _A2>): infer _R2
    (...args: ArgsWithCallback<infer _Args3, infer E3, infer _A3>): infer _R3
    (...args: ArgsWithCallback<infer _Args4, infer E4, infer _A4>): infer _R4
    (...args: ArgsWithCallback<infer _Args5, infer E5, infer _A5>): infer _R5
    (...args: ArgsWithCallback<infer _Args6, infer E6, infer _A6>): infer _R6
    (...args: ArgsWithCallback<infer _Args7, infer E7, infer _A7>): infer _R7
    (...args: ArgsWithCallback<infer _Args8, infer E8, infer _A8>): infer _R8
    (...args: ArgsWithCallback<infer _Args9, infer E9, infer _A9>): infer _R9
    (...args: ArgsWithCallback<infer _Args10, infer E10, infer _A10>): infer _R10
  } ? NonNullable<E1 | E2 | E3 | E4 | E5 | E6 | E7 | E8 | E9 | E10>
    : T extends {
      (...args: ArgsWithCallback<infer _Args1, infer E1, infer _A1>): infer _R1
      (...args: ArgsWithCallback<infer _Args2, infer E2, infer _A2>): infer _R2
      (...args: ArgsWithCallback<infer _Args3, infer E3, infer _A3>): infer _R3
      (...args: ArgsWithCallback<infer _Args4, infer E4, infer _A4>): infer _R4
      (...args: ArgsWithCallback<infer _Args5, infer E5, infer _A5>): infer _R5
      (...args: ArgsWithCallback<infer _Args6, infer E6, infer _A6>): infer _R6
      (...args: ArgsWithCallback<infer _Args7, infer E7, infer _A7>): infer _R7
      (...args: ArgsWithCallback<infer _Args8, infer E8, infer _A8>): infer _R8
      (...args: ArgsWithCallback<infer _Args9, infer E9, infer _A9>): infer _R9
    } ? NonNullable<E1 | E2 | E3 | E4 | E5 | E6 | E7 | E8 | E9>
    : T extends {
      (...args: ArgsWithCallback<infer _Args1, infer E1, infer _A1>): infer _R1
      (...args: ArgsWithCallback<infer _Args2, infer E2, infer _A2>): infer _R2
      (...args: ArgsWithCallback<infer _Args3, infer E3, infer _A3>): infer _R3
      (...args: ArgsWithCallback<infer _Args4, infer E4, infer _A4>): infer _R4
      (...args: ArgsWithCallback<infer _Args5, infer E5, infer _A5>): infer _R5
      (...args: ArgsWithCallback<infer _Args6, infer E6, infer _A6>): infer _R6
      (...args: ArgsWithCallback<infer _Args7, infer E7, infer _A7>): infer _R7
      (...args: ArgsWithCallback<infer _Args8, infer E8, infer _A8>): infer _R8
    } ? NonNullable<E1 | E2 | E3 | E4 | E5 | E6 | E7 | E8>
    : T extends {
      (...args: ArgsWithCallback<infer _Args1, infer E1, infer _A1>): infer _R1
      (...args: ArgsWithCallback<infer _Args2, infer E2, infer _A2>): infer _R2
      (...args: ArgsWithCallback<infer _Args3, infer E3, infer _A3>): infer _R3
      (...args: ArgsWithCallback<infer _Args4, infer E4, infer _A4>): infer _R4
      (...args: ArgsWithCallback<infer _Args5, infer E5, infer _A5>): infer _R5
      (...args: ArgsWithCallback<infer _Args6, infer E6, infer _A6>): infer _R6
      (...args: ArgsWithCallback<infer _Args7, infer E7, infer _A7>): infer _R7
    } ? NonNullable<E1 | E2 | E3 | E4 | E5 | E6 | E7>
    : T extends {
      (...args: ArgsWithCallback<infer _Args1, infer E1, infer _A1>): infer _R1
      (...args: ArgsWithCallback<infer _Args2, infer E2, infer _A2>): infer _R2
      (...args: ArgsWithCallback<infer _Args3, infer E3, infer _A3>): infer _R3
      (...args: ArgsWithCallback<infer _Args4, infer E4, infer _A4>): infer _R4
      (...args: ArgsWithCallback<infer _Args5, infer E5, infer _A5>): infer _R5
      (...args: ArgsWithCallback<infer _Args6, infer E6, infer _A6>): infer _R6
    } ? NonNullable<E1 | E2 | E3 | E4 | E5 | E6>
    : T extends {
      (...args: ArgsWithCallback<infer _Args1, infer E1, infer _A1>): infer _R1
      (...args: ArgsWithCallback<infer _Args2, infer E2, infer _A2>): infer _R2
      (...args: ArgsWithCallback<infer _Args3, infer E3, infer _A3>): infer _R3
      (...args: ArgsWithCallback<infer _Args4, infer E4, infer _A4>): infer _R4
      (...args: ArgsWithCallback<infer _Args5, infer E5, infer _A5>): infer _R5
    } ? NonNullable<E1 | E2 | E3 | E4 | E5>
    : T extends {
      (...args: ArgsWithCallback<infer _Args1, infer E1, infer _A1>): infer _R1
      (...args: ArgsWithCallback<infer _Args2, infer E2, infer _A2>): infer _R2
      (...args: ArgsWithCallback<infer _Args3, infer E3, infer _A3>): infer _R3
      (...args: ArgsWithCallback<infer _Args4, infer E4, infer _A4>): infer _R4
    } ? NonNullable<E1 | E2 | E3 | E4>
    : T extends {
      (...args: ArgsWithCallback<infer _Args1, infer E1, infer _A1>): infer _R1
      (...args: ArgsWithCallback<infer _Args2, infer E2, infer _A2>): infer _R2
      (...args: ArgsWithCallback<infer _Args3, infer E3, infer _A3>): infer _R3
    } ? NonNullable<E1 | E2 | E3>
    : T extends {
      (...args: ArgsWithCallback<infer _Args1, infer E1, infer _A1>): infer _R1
      (...args: ArgsWithCallback<infer _Args2, infer E2, infer _A2>): infer _R2
    } ? NonNullable<E1 | E2>
    : T extends {
      (...args: ArgsWithCallback<infer _Args1, infer E1, infer _A1>): infer _R1
    } ? NonNullable<E1>
    : never
}

/**
 * Converts an error-first callback API into a function that returns an
 * `Effect`.
 *
 * **Details**
 *
 * The original function is called with the supplied arguments plus a final
 * callback. A non-null callback error fails the returned effect, while a
 * successful callback value becomes the effect success. Use `onError` to map
 * callback errors and `onSyncError` to turn synchronous throws into typed
 * failures; otherwise synchronous throws become defects.
 *
 * **Example** (Converting callbacks to effects)
 *
 * ```ts
 * import { Effect } from "effect"
 * import * as fs from "fs"
 *
 * // Convert Node.js readFile to an Effect
 * const readFile = Effect.effectify(fs.readFile)
 *
 * // Use the effectified function
 * const program = readFile("package.json", "utf8")
 *
 * Effect.runPromise(program).then(console.log)
 * // Output: contents of package.json
 * ```
 *
 * **Example** (Mapping callback errors to typed failures)
 *
 * ```ts
 * import { Effect } from "effect"
 * import * as fs from "fs"
 *
 * const readFile = Effect.effectify(
 *   fs.readFile,
 *   (error, args) => new Error(`Failed to read file ${args[0]}: ${error.message}`)
 * )
 *
 * const program = readFile("nonexistent.txt", "utf8")
 *
 * Effect.runPromiseExit(program).then(console.log)
 * // Output: Exit.failure with custom error message
 * ```
 *
 * @category effectify
 * @since 4.0.0
 */
export const effectify: {
  <F extends (...args: Array<any>) => any>(fn: F): Effectify.Effectify<F, Effectify.EffectifyError<F>>
  <F extends (...args: Array<any>) => any, E>(
    fn: F,
    onError: (error: Effectify.EffectifyError<F>, args: Parameters<F>) => E
  ): Effectify.Effectify<F, E>
  <F extends (...args: Array<any>) => any, E, E2>(
    fn: F,
    onError: (error: Effectify.EffectifyError<F>, args: Parameters<F>) => E,
    onSyncError: (error: unknown, args: Parameters<F>) => E2
  ): Effectify.Effectify<F, E | E2>
} =
  (<A>(fn: Function, onError?: (e: any, args: any) => any, onSyncError?: (e: any, args: any) => any) =>
  (...args: Array<any>) =>
    callback<A, globalThis.Error>((resume) => {
      try {
        fn(...args, (err: globalThis.Error | null, result: A) => {
          if (err) {
            resume(fail(onError ? onError(err, args) : err))
          } else {
            resume(succeed(result))
          }
        })
      } catch (err) {
        resume(onSyncError ? fail(onSyncError(err, args)) : die(err))
      }
    })) as any

// -----------------------------------------------------------------------------
// Type constraints
// -----------------------------------------------------------------------------

/**
 * Ensures that an effect's success type extends a given type `A`.
 *
 * **Details**
 *
 * This helper is checked at compile time and does not change the effect's
 * runtime behavior.
 *
 * **Example** (Constraining the success type)
 *
 * ```ts
 * import { Effect } from "effect"
 *
 * // Define a constraint that the success type must be a number
 * const satisfiesNumber = Effect.satisfiesSuccessType<number>()
 *
 * // This works - Effect<42, never, never> extends Effect<number, never, never>
 * const validEffect = satisfiesNumber(Effect.succeed(42))
 *
 * // This would cause a TypeScript compilation error:
 * // const invalidEffect = satisfiesNumber(Effect.succeed("string"))
 * //                                      ^^^^^^^^^^^^^^^^^^^^^^
 * // Type 'string' is not assignable to type 'number'
 * ```
 *
 * @category utility types
 * @since 4.0.0
 */
export const satisfiesSuccessType = <A>() => <A2 extends A, E, R>(effect: Effect<A2, E, R>): Effect<A2, E, R> => effect

/**
 * Ensures that an effect's error type extends a given type `E`.
 *
 * **Details**
 *
 * This helper is checked at compile time and does not change the effect's
 * runtime behavior.
 *
 * **Example** (Constraining the error type)
 *
 * ```ts
 * import { Data, Effect } from "effect"
 *
 * class ValidationError extends Data.TaggedError("ValidationError")<{}> {}
 *
 * // Define a constraint that the error type must be a ValidationError
 * const satisfiesError = Effect.satisfiesErrorType<ValidationError>()
 *
 * // This works - Effect<number, ValidationError, never> extends the constrained type
 * const validEffect = satisfiesError(Effect.fail(new ValidationError()))
 *
 * // This would cause a TypeScript compilation error:
 * // const invalidEffect = satisfiesError(Effect.fail("string error"))
 * //                                     ^^^^^^^^^^^^^^^^^^^^^^^^^^^
 * // Type 'string' is not assignable to type 'ValidationError'
 * ```
 *
 * @category utility types
 * @since 4.0.0
 */
export const satisfiesErrorType = <E>() => <A, E2 extends E, R>(effect: Effect<A, E2, R>): Effect<A, E2, R> => effect

/**
 * Ensures that an effect's requirements type extends a given type `R`.
 *
 * **Details**
 *
 * This helper is checked at compile time and does not change the effect's
 * runtime behavior.
 *
 * **Example** (Constraining the services type)
 *
 * ```ts
 * import { Effect } from "effect"
 *
 * // Define a constraint that requires a string as the requirements type
 * const satisfiesStringServices = Effect.satisfiesServicesType<string>()
 *
 * // This works - effect requires string
 * const validEffect: Effect.Effect<number, never, "config"> = Effect.succeed(42)
 * const constrainedEffect = satisfiesStringServices(validEffect)
 *
 * // This would cause a TypeScript compilation error if uncommented:
 * // const invalidEffect: Effect.Effect<number, never, number> = Effect.succeed(42)
 * // const constrainedInvalid = satisfiesStringServices(invalidEffect)
 * ```
 *
 * @category utility types
 * @since 4.0.0
 */
export const satisfiesServicesType = <R>() => <A, E, R2 extends R>(effect: Effect<A, E, R2>): Effect<A, E, R2> => effect

/**
 * Applies `map` eagerly when an effect is already resolved.
 *
 * **When to use**
 *
 * Use when an already-resolved effect should apply a success transformation
 * immediately while pending effects still use regular mapping.
 *
 * **Details**
 *
 * Behavior:
 *
 * - For **Success effects**: Applies the mapping function immediately to the value
 * - For **Failure effects**: Returns the failure as-is without applying the mapping
 * - For **Pending effects**: Falls back to the regular `map` behavior
 *
 * **Example** (Mapping already completed effects)
 *
 * ```ts
 * import { Effect } from "effect"
 *
 * // For resolved effects, the mapping is applied immediately
 * const resolved = Effect.succeed(5)
 * const mapped = Effect.mapEager(resolved, (n) => n * 2) // Applied eagerly
 *
 * // For pending effects, behaves like regular map
 * const pending = Effect.delay(Effect.succeed(5), "100 millis")
 * const mappedPending = Effect.mapEager(pending, (n) => n * 2) // Uses regular map
 * ```
 *
 * @category eager
 * @since 4.0.0
 */
export const mapEager: {
  <A, B>(f: (a: A) => B): <E, R>(self: Effect<A, E, R>) => Effect<B, E, R>
  <A, E, R, B>(self: Effect<A, E, R>, f: (a: A) => B): Effect<B, E, R>
} = internal.mapEager

/**
 * Applies `mapError` eagerly when an effect is already resolved.
 *
 * **When to use**
 *
 * Use when an already-resolved failed effect should apply an error
 * transformation immediately while pending effects still use regular error
 * mapping.
 *
 * **Details**
 *
 * Behavior:
 *
 * - For **Success effects**: Returns the success as-is (no error to transform)
 * - For **Failure effects**: Applies the mapping function immediately to the error
 * - For **Pending effects**: Falls back to the regular `mapError` behavior
 *
 * **Example** (Mapping errors eagerly when possible)
 *
 * ```ts
 * import { Effect } from "effect"
 *
 * // For resolved failure effects, the error mapping is applied immediately
 * const failed = Effect.fail("original error")
 * const mapped = Effect.mapErrorEager(failed, (err: string) => `mapped: ${err}`) // Applied eagerly
 *
 * // For pending effects, behaves like regular mapError
 * const pending = Effect.delay(Effect.fail("error"), "100 millis")
 * const mappedPending = Effect.mapErrorEager(
 *   pending,
 *   (err: string) => `mapped: ${err}`
 * ) // Uses regular mapError
 * ```
 *
 * @category eager
 * @since 4.0.0
 */
export const mapErrorEager: {
  <E, E2>(f: (e: E) => E2): <A, R>(self: Effect<A, E, R>) => Effect<A, E2, R>
  <A, E, R, E2>(self: Effect<A, E, R>, f: (e: E) => E2): Effect<A, E2, R>
} = internal.mapErrorEager

/**
 * Applies `mapBoth` eagerly when an effect is already resolved.
 *
 * **When to use**
 *
 * Use when an already-resolved effect should transform either success or
 * failure immediately while pending effects still use regular channel mapping.
 *
 * **Details**
 *
 * Behavior:
 *
 * - For **Success effects**: Applies the `onSuccess` function immediately to the value
 * - For **Failure effects**: Applies the `onFailure` function immediately to the error
 * - For **Pending effects**: Falls back to the regular `mapBoth` behavior
 *
 * **Example** (Mapping both channels eagerly when possible)
 *
 * ```ts
 * import { Effect } from "effect"
 *
 * // For resolved effects, the appropriate mapping is applied immediately
 * const success = Effect.succeed(5)
 * const mapped = Effect.mapBothEager(success, {
 *   onFailure: (err: string) => `Failed: ${err}`,
 *   onSuccess: (n: number) => n * 2
 * }) // onSuccess applied eagerly
 *
 * const failure = Effect.fail("error")
 * const mappedError = Effect.mapBothEager(failure, {
 *   onFailure: (err: string) => `Failed: ${err}`,
 *   onSuccess: (n: number) => n * 2
 * }) // onFailure applied eagerly
 * ```
 *
 * @category eager
 * @since 4.0.0
 */
export const mapBothEager: {
  <E, E2, A, A2>(
    options: { readonly onFailure: (e: E) => E2; readonly onSuccess: (a: A) => A2 }
  ): <R>(self: Effect<A, E, R>) => Effect<A2, E2, R>
  <A, E, R, E2, A2>(
    self: Effect<A, E, R>,
    options: { readonly onFailure: (e: E) => E2; readonly onSuccess: (a: A) => A2 }
  ): Effect<A2, E2, R>
} = internal.mapBothEager

/**
 * Applies `flatMap` eagerly when an effect is already resolved.
 *
 * **When to use**
 *
 * Use when an already-resolved successful effect should bind immediately to the
 * next effect while pending effects still use regular flat mapping.
 *
 * **Details**
 *
 * Behavior:
 *
 * - For **Success effects**: Applies the flatMap function immediately to the value
 * - For **Failure effects**: Returns the failure as-is without applying the flatMap
 * - For **Pending effects**: Falls back to the regular `flatMap` behavior
 *
 * **Example** (Flat mapping eagerly when possible)
 *
 * ```ts
 * import { Effect } from "effect"
 *
 * // For resolved effects, the flatMap is applied immediately
 * const resolved = Effect.succeed(5)
 * const flatMapped = Effect.flatMapEager(resolved, (n) => Effect.succeed(n * 2)) // Applied eagerly
 *
 * // For pending effects, behaves like regular flatMap
 * const pending = Effect.delay(Effect.succeed(5), "100 millis")
 * const flatMappedPending = Effect.flatMapEager(
 *   pending,
 *   (n) => Effect.succeed(n * 2)
 * ) // Uses regular flatMap
 * ```
 *
 * @category eager
 * @since 4.0.0
 */
export const flatMapEager: {
  <A, B, E2, R2>(f: (a: A) => Effect<B, E2, R2>): <E, R>(self: Effect<A, E, R>) => Effect<B, E | E2, R | R2>
  <A, E, R, B, E2, R2>(self: Effect<A, E, R>, f: (a: A) => Effect<B, E2, R2>): Effect<B, E | E2, R | R2>
} = internal.flatMapEager

/**
 * Applies `catch` eagerly when an effect is already resolved.
 *
 * **When to use**
 *
 * Use when an already-resolved failed effect should recover immediately while
 * pending effects still use regular error recovery.
 *
 * **Details**
 *
 * Behavior:
 *
 * - For **Success effects**: Returns the success as-is (no error to catch)
 * - For **Failure effects**: Applies the catch function immediately to the error
 * - For **Pending effects**: Falls back to the regular `catch` behavior
 *
 * **Example** (Catching failures eagerly when possible)
 *
 * ```ts
 * import { Effect } from "effect"
 *
 * // For resolved failure effects, the catch function is applied immediately
 * const failed = Effect.fail("original error")
 * const recovered = Effect.catchEager(
 *   failed,
 *   (err: string) => Effect.succeed(`recovered from: ${err}`)
 * ) // Applied eagerly
 *
 * // For success effects, returns success as-is
 * const success = Effect.succeed(42)
 * const unchanged = Effect.catchEager(
 *   success,
 *   (err: string) => Effect.succeed(`recovered from: ${err}`)
 * ) // Returns success as-is
 *
 * // For pending effects, behaves like regular catch
 * const pending = Effect.delay(Effect.fail("error"), "100 millis")
 * const recoveredPending = Effect.catchEager(
 *   pending,
 *   (err: string) => Effect.succeed(`recovered from: ${err}`)
 * ) // Uses regular catch
 * ```
 *
 * @category eager
 * @since 4.0.0
 */
export const catchEager: {
  <E, B, E2, R2>(
    f: (e: NoInfer<E>) => Effect<B, E2, R2>
  ): <A, R>(self: Effect<A, E, R>) => Effect<A | B, E2, R | R2>
  <A, E, R, B, E2, R2>(
    self: Effect<A, E, R>,
    f: (e: NoInfer<E>) => Effect<B, E2, R2>
  ): Effect<A | B, E2, R | R2>
} = internal.catchEager

/**
 * Creates untraced function effects with eager evaluation optimization.
 *
 * **Details**
 *
 * Executes generator functions eagerly when all yielded effects are synchronous,
 * stopping at the first async effect and deferring to normal execution.
 *
 * **Example** (Defining eager untraced effect functions)
 *
 * ```ts
 * import { Effect } from "effect"
 *
 * const computation = Effect.fnUntracedEager(function*() {
 *   yield* Effect.succeed(1)
 *   yield* Effect.succeed(2)
 *   return "computed eagerly"
 * })
 *
 * const effect = computation() // Executed immediately if all effects are sync
 * ```
 *
 * @category eager
 * @since 4.0.0
 */
export const fnUntracedEager: fn.Untraced = internal.fnUntracedEager

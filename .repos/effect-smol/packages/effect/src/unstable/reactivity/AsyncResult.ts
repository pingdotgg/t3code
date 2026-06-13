/**
 * State containers for asynchronous values used by the reactivity APIs.
 *
 * `AsyncResult` records the latest observable state of work that may still be
 * loading, refreshing, retrying, or recovering from failure. The value is one of
 * `Initial`, `Success`, or `Failure`, and every variant also carries a `waiting`
 * flag so callers can keep rendering the current state while newer work is in
 * flight.
 *
 * **Mental model**
 *
 * The variant answers "what do we know right now?", while `waiting` answers "is
 * newer work currently running?". A success contains the current value and its
 * timestamp. A failure contains a `Cause` and may also keep the previous
 * success, which lets UI and atom code show stale data while exposing the latest
 * failure for error displays and retry logic.
 *
 * **Common tasks**
 *
 * - Start with {@link initial}, {@link success}, {@link failure}, or
 *   {@link fail}
 * - Convert Effect exits with {@link fromExit} and
 *   {@link fromExitWithPrevious}
 * - Mark existing state as loading with {@link waiting} or
 *   {@link waitingFrom}
 * - Read values and failures with {@link value}, {@link cause}, {@link error},
 *   {@link getOrElse}, and {@link toExit}
 * - Transform and combine results with {@link map}, {@link flatMap}, and
 *   {@link all}
 * - Render all states with {@link match}, {@link matchWithWaiting}, or
 *   {@link builder}
 *
 * **Gotchas**
 *
 * - `waiting` is an overlay, not a fourth variant; any variant can be waiting.
 * - {@link value} and {@link getOrElse} can read the previous success stored in
 *   a failure, so inspect {@link cause} or {@link error} when stale data and a
 *   current success must be distinguished.
 * - {@link matchWithWaiting} handles waiting before variant-specific branches,
 *   while {@link match} and {@link matchWithError} expose the underlying
 *   variant first.
 *
 * @since 4.0.0
 */
import * as Cause from "../../Cause.ts"
import * as Effect from "../../Effect.ts"
import * as Equal from "../../Equal.ts"
import * as Exit from "../../Exit.ts"
import type { LazyArg } from "../../Function.ts"
import { constTrue, dual, identity } from "../../Function.ts"
import * as Hash from "../../Hash.ts"
import * as Option from "../../Option.ts"
import { type Pipeable, pipeArguments } from "../../Pipeable.ts"
import type { Predicate, Refinement } from "../../Predicate.ts"
import { hasProperty, isIterable } from "../../Predicate.ts"
import * as Result from "../../Result.ts"
import * as Schema_ from "../../Schema.ts"
import * as SchemaIssue from "../../SchemaIssue.ts"
import * as SchemaParser from "../../SchemaParser.ts"
import * as SchemaTransformation from "../../SchemaTransformation.ts"
import type * as Types from "../../Types.ts"

/**
 * Type-level identifier used to recognize `AsyncResult` values.
 *
 * @category type IDs
 * @since 4.0.0
 */
export type TypeId = "~effect/reactivity/AsyncResult"

/**
 * Runtime identifier attached to `AsyncResult` values and used by `isAsyncResult`.
 *
 * @category type IDs
 * @since 4.0.0
 */
export const TypeId: TypeId = "~effect/reactivity/AsyncResult"

/**
 * Represents the state of an asynchronous value as `Initial`, `Success`, or `Failure`, with a `waiting` flag for in-flight refreshes.
 *
 * @category models
 * @since 4.0.0
 */
export type AsyncResult<A, E = never> = Initial<A, E> | Success<A, E> | Failure<A, E>

/**
 * Returns `true` when a value is an `AsyncResult`.
 *
 * @category guards
 * @since 4.0.0
 */
export const isAsyncResult = (u: unknown): u is AsyncResult<unknown, unknown> => hasProperty(u, TypeId)

/**
 * Namespace containing type-level helpers and the shared prototype shape for `AsyncResult` values.
 *
 * @since 4.0.0
 */
export declare namespace AsyncResult {
  /**
   * Common prototype fields implemented by every `AsyncResult` variant, including pipeability, the type marker, phantom type members, and the `waiting` flag.
   *
   * @category models
   * @since 4.0.0
   */
  export interface Proto<A, E> extends Pipeable {
    readonly [TypeId]: {
      readonly E: (_: never) => E
      readonly A: (_: never) => A
    }
    readonly waiting: boolean
  }

  /**
   * Extracts the success value type from an `AsyncResult`.
   *
   * @category utility types
   * @since 4.0.0
   */
  export type Success<R> = R extends AsyncResult<infer A, infer _> ? A : never

  /**
   * Extracts the failure error type from an `AsyncResult`.
   *
   * @category utility types
   * @since 4.0.0
   */
  export type Failure<R> = R extends AsyncResult<infer _, infer E> ? E : never
}

/**
 * Rebuilds an `AsyncResult` with new success and failure types while preserving the variant of another result.
 *
 * @category utility types
 * @since 4.0.0
 */
export type With<R extends AsyncResult<any, any>, A, E> = R extends Initial<infer _A, infer _E> ? Initial<A, E>
  : R extends Success<infer _A, infer _E> ? Success<A, E>
  : R extends Failure<infer _A, infer _E> ? Failure<A, E>
  : never

const ResultProto = {
  [TypeId]: {
    E: identity,
    A: identity
  },
  pipe() {
    return pipeArguments(this, arguments)
  },
  [Equal.symbol](this: AsyncResult<any, any>, that: AsyncResult<any, any>): boolean {
    if (this._tag !== that._tag || this.waiting !== that.waiting) {
      return false
    }
    switch (this._tag) {
      case "Initial":
        return true
      case "Success":
        return Equal.equals(this.value, (that as Success<any, any>).value)
      case "Failure":
        return Equal.equals(this.cause, (that as Failure<any, any>).cause)
    }
  },
  [Hash.symbol](this: AsyncResult<any, any>): number {
    const tagHash = Hash.string(`${this._tag}:${this.waiting}`)
    if (this._tag === "Initial") {
      return tagHash
    }
    return Hash.combine(tagHash)(this._tag === "Success" ? Hash.hash(this.value) : Hash.hash(this.cause))
  }
}

/**
 * Returns whether an `AsyncResult` is currently waiting for an asynchronous computation or refresh to finish.
 *
 * @category refinements
 * @since 4.0.0
 */
export const isWaiting = <A, E>(result: AsyncResult<A, E>): boolean => result.waiting

/**
 * Initial `AsyncResult` state before a success value or failure cause is available.
 *
 * @category models
 * @since 4.0.0
 */
export interface Initial<A, E = never> extends AsyncResult.Proto<A, E> {
  readonly _tag: "Initial"
}

/**
 * Converts an `Exit` into a `Success` when it succeeds or a `Failure` carrying the exit cause when it fails.
 *
 * @category constructors
 * @since 4.0.0
 */
export const fromExit = <A, E>(exit: Exit.Exit<A, E>): Success<A, E> | Failure<A, E> =>
  exit._tag === "Success" ? success(exit.value) : failure(exit.cause)

/**
 * Converts an `Exit` to a result, preserving the latest previous success when the exit is a failure.
 *
 * @category constructors
 * @since 4.0.0
 */
export const fromExitWithPrevious = <A, E>(
  exit: Exit.Exit<A, E>,
  previous: Option.Option<AsyncResult<A, E>>
): Success<A, E> | Failure<A, E> =>
  exit._tag === "Success" ? success(exit.value) : failureWithPrevious(exit.cause, { previous })

/**
 * Creates a waiting result from an optional previous result, using `Initial(true)` when no previous result exists.
 *
 * @category constructors
 * @since 4.0.0
 */
export const waitingFrom = <A, E>(previous: Option.Option<AsyncResult<A, E>>): AsyncResult<A, E> => {
  if (previous._tag === "None") {
    return initial(true)
  }
  return waiting(previous.value)
}

/**
 * Returns `true` when an `AsyncResult` is in the `Initial` state.
 *
 * @category refinements
 * @since 4.0.0
 */
export const isInitial = <A, E>(result: AsyncResult<A, E>): result is Initial<A, E> => result._tag === "Initial"

/**
 * Returns `true` when an `AsyncResult` is either `Success` or `Failure`.
 *
 * @category refinements
 * @since 4.0.0
 */
export const isNotInitial = <A, E>(result: AsyncResult<A, E>): result is Success<A, E> | Failure<A, E> =>
  result._tag !== "Initial"

/**
 * Creates an `Initial` result, optionally marking it as waiting.
 *
 * @category constructors
 * @since 4.0.0
 */
export const initial = <A = never, E = never>(waiting = false): Initial<A, E> => {
  const result = Object.create(ResultProto)
  result._tag = "Initial"
  result.waiting = waiting
  return result
}

/**
 * Successful `AsyncResult` containing the current value, its timestamp, and the shared waiting flag.
 *
 * @category models
 * @since 4.0.0
 */
export interface Success<A, E = never> extends AsyncResult.Proto<A, E> {
  readonly _tag: "Success"
  readonly value: A
  readonly timestamp: number
}

/**
 * Returns `true` when an `AsyncResult` is a `Success`.
 *
 * @category refinements
 * @since 4.0.0
 */
export const isSuccess = <A, E>(result: AsyncResult<A, E>): result is Success<A, E> => result._tag === "Success"

/**
 * Creates a `Success` result with a value and optional `waiting` flag or timestamp override.
 *
 * @category constructors
 * @since 4.0.0
 */
export const success = <A, E = never>(value: A, options?: {
  readonly waiting?: boolean | undefined
  readonly timestamp?: number | undefined
}): Success<A, E> => {
  const result = Object.create(ResultProto)
  result._tag = "Success"
  result.value = value
  result.waiting = options?.waiting ?? false
  result.timestamp = options?.timestamp ?? Date.now()
  return result
}

/**
 * Failed `AsyncResult` containing a failure cause and the latest previous success when one is available.
 *
 * @category models
 * @since 4.0.0
 */
export interface Failure<A, E = never> extends AsyncResult.Proto<A, E> {
  readonly _tag: "Failure"
  readonly cause: Cause.Cause<E>
  readonly previousSuccess: Option.Option<Success<A, E>>
}

/**
 * Returns `true` when an `AsyncResult` is a `Failure`.
 *
 * @category refinements
 * @since 4.0.0
 */
export const isFailure = <A, E>(result: AsyncResult<A, E>): result is Failure<A, E> => result._tag === "Failure"

/**
 * Returns `true` when an `AsyncResult` is a `Failure` whose cause contains only interruptions.
 *
 * @category refinements
 * @since 4.0.0
 */
export const isInterrupted = <A, E>(result: AsyncResult<A, E>): result is Failure<A, E> =>
  result._tag === "Failure" && Cause.hasInterruptsOnly(result.cause)

/**
 * Creates a `Failure` result from a `Cause`, optionally preserving a previous success and marking the result as waiting.
 *
 * @category constructors
 * @since 4.0.0
 */
export const failure = <A, E = never>(
  cause: Cause.Cause<E>,
  options?: {
    readonly previousSuccess?: Option.Option<Success<A, E>> | undefined
    readonly waiting?: boolean | undefined
  }
): Failure<A, E> => {
  const result = Object.create(ResultProto)
  result._tag = "Failure"
  result.cause = cause
  result.previousSuccess = options?.previousSuccess ?? Option.none()
  result.waiting = options?.waiting ?? false
  return result
}

/**
 * Creates a `Failure` result from a `Cause`, carrying forward the latest success stored in a previous result.
 *
 * @category constructors
 * @since 4.0.0
 */
export const failureWithPrevious = <A, E>(
  cause: Cause.Cause<E>,
  options: {
    readonly previous: Option.Option<AsyncResult<A, E>>
    readonly waiting?: boolean | undefined
  }
): Failure<A, E> =>
  failure(cause, {
    previousSuccess: Option.flatMap(options.previous, (result) =>
      isSuccess(result)
        ? Option.some(result)
        : isFailure(result)
        ? result.previousSuccess
        : Option.none()),
    waiting: options.waiting
  })

/**
 * Creates a `Failure` result from a typed error, wrapping it in `Cause.fail`.
 *
 * @category constructors
 * @since 4.0.0
 */
export const fail = <E, A = never>(error: E, options?: {
  readonly previousSuccess?: Option.Option<Success<A, E>> | undefined
  readonly waiting?: boolean | undefined
}): Failure<A, E> => failure(Cause.fail(error), options)

/**
 * Creates a `Failure` result from a typed error while carrying forward the latest success stored in a previous result.
 *
 * @category constructors
 * @since 4.0.0
 */
export const failWithPrevious = <A, E>(
  error: E,
  options: {
    readonly previous: Option.Option<AsyncResult<A, E>>
    readonly waiting?: boolean | undefined
  }
): Failure<A, E> => failureWithPrevious(Cause.fail(error), options)

/**
 * Marks an `AsyncResult` as waiting, optionally touching the timestamp when the result is a `Success`.
 *
 * @category constructors
 * @since 4.0.0
 */
export const waiting = <R extends AsyncResult<any, any>>(self: R, options?: {
  readonly touch?: boolean | undefined
}): R => {
  if (self.waiting) {
    return options?.touch ? touch(self) : self
  }
  const result = Object.assign(Object.create(ResultProto), self)
  result.waiting = true
  if (options?.touch && isSuccess(result)) {
    ;(result as any).timestamp = Date.now()
  }
  return result
}

/**
 * Refreshes the timestamp of a `Success` result while preserving its value and waiting flag; non-success results are returned unchanged.
 *
 * @category combinators
 * @since 4.0.0
 */
export const touch = <A extends AsyncResult<any, any>>(result: A): A => {
  if (isSuccess(result)) {
    return success(result.value, { waiting: result.waiting }) as A
  }
  return result
}

/**
 * Replaces a `Failure` value's stored previous success with the latest success
 * found in another result.
 *
 * @category combinators
 * @since 4.0.0
 */
export const replacePrevious = <R extends AsyncResult<any, any>, XE, A>(
  self: R,
  previous: Option.Option<AsyncResult<A, XE>>
): With<R, A, AsyncResult.Failure<R>> => {
  if (self._tag === "Failure") {
    return failureWithPrevious(self.cause, { previous, waiting: self.waiting }) as any
  }
  return self as any
}

/**
 * Returns the current success value, or the previous success value stored in a failure, as an `Option`.
 *
 * @category accessors
 * @since 4.0.0
 */
export const value = <A, E>(self: AsyncResult<A, E>): Option.Option<A> => {
  if (self._tag === "Success") {
    return Option.some(self.value)
  } else if (self._tag === "Failure") {
    return Option.map(self.previousSuccess, (s) => s.value)
  }
  return Option.none()
}

/**
 * Returns the available value from `value`, or evaluates the fallback when no current or previous success exists.
 *
 * @category accessors
 * @since 4.0.0
 */
export const getOrElse: {
  <B>(orElse: LazyArg<B>): <A, E>(self: AsyncResult<A, E>) => A | B
  <A, E, B>(self: AsyncResult<A, E>, orElse: LazyArg<B>): A | B
} = dual(2, <A, E, B>(self: AsyncResult<A, E>, orElse: LazyArg<B>): A | B => Option.getOrElse(value(self), orElse))

/**
 * Returns the available value from `value`, or throws `NoSuchElementError` when no current or previous success exists.
 *
 * @category accessors
 * @since 4.0.0
 */
export const getOrThrow = <A, E>(self: AsyncResult<A, E>): A =>
  Option.getOrThrowWith(value(self), () => new Cause.NoSuchElementError("AsyncResult.getOrThrow: no value found"))

/**
 * Returns the failure cause when the result is a `Failure`, otherwise `None`.
 *
 * @category accessors
 * @since 4.0.0
 */
export const cause = <A, E>(self: AsyncResult<A, E>): Option.Option<Cause.Cause<E>> =>
  self._tag === "Failure" ? Option.some(self.cause) : Option.none()

/**
 * Returns the first typed error from a failure cause, or `None` for successes, initial results, defects, and interrupt-only causes.
 *
 * @category accessors
 * @since 4.0.0
 */
export const error = <A, E>(self: AsyncResult<A, E>): Option.Option<E> =>
  self._tag === "Failure" ? Cause.findErrorOption(self.cause) : Option.none()

/**
 * Converts a result to an `Exit`, succeeding with a success value, failing with a failure cause, or failing with `NoSuchElementError` for `Initial`.
 *
 * @category combinators
 * @since 4.0.0
 */
export const toExit = <A, E>(
  self: AsyncResult<A, E>
): Exit.Exit<A, E | Cause.NoSuchElementError> => {
  switch (self._tag) {
    case "Success": {
      return Exit.succeed(self.value)
    }
    case "Failure": {
      return Exit.failCause(self.cause)
    }
    default: {
      return Exit.fail(new Cause.NoSuchElementError())
    }
  }
}

/**
 * Maps the success value of an `AsyncResult`, also mapping any previous success stored in a failure while leaving initial results unchanged.
 *
 * @category combinators
 * @since 4.0.0
 */
export const map: {
  <A, B>(f: (a: A) => B): <E>(self: AsyncResult<A, E>) => AsyncResult<B, E>
  <E, A, B>(self: AsyncResult<A, E>, f: (a: A) => B): AsyncResult<B, E>
} = dual(2, <E, A, B>(self: AsyncResult<A, E>, f: (a: A) => B): AsyncResult<B, E> => {
  switch (self._tag) {
    case "Initial":
      return self as any as AsyncResult<B, E>
    case "Failure":
      return failure(self.cause, {
        previousSuccess: Option.map(self.previousSuccess, (s) => success(f(s.value), s)),
        waiting: self.waiting
      })
    case "Success":
      return success(f(self.value), self)
  }
})

/**
 * Maps the success value of an `AsyncResult` and flattens the result.
 *
 * **When to use**
 *
 * Use to sequence computations that may return another `AsyncResult` while
 * preserving initial and failure states.
 *
 * **Details**
 *
 * Initial results are left unchanged. Failures preserve their cause and remap
 * the stored previous success when the mapping function returns a success.
 *
 * @category combinators
 * @since 4.0.0
 */
export const flatMap: {
  <A, E, B, E2>(
    f: (a: A, prev: Success<A, E>) => AsyncResult<A, E2>
  ): (self: AsyncResult<A, E>) => AsyncResult<B, E | E2>
  <E, A, B, E2>(self: AsyncResult<A, E>, f: (a: A, prev: Success<A, E>) => AsyncResult<B, E2>): AsyncResult<B, E | E2>
} = dual(
  2,
  <E, A, B, E2>(
    self: AsyncResult<A, E>,
    f: (a: A, prev: Success<A, E>) => AsyncResult<B, E2>
  ): AsyncResult<B, E | E2> => {
    switch (self._tag) {
      case "Initial":
        return self as any as AsyncResult<B, E>
      case "Failure":
        return failure<B, E | E2>(self.cause, {
          previousSuccess: Option.flatMap(self.previousSuccess, (s) => {
            const next = f(s.value, s)
            return isSuccess(next) ? Option.some(next) : Option.none()
          }),
          waiting: self.waiting
        })
      case "Success":
        return f(self.value, self)
    }
  }
)

/**
 * Pattern matches an `AsyncResult` by calling the handler for `Initial`, `Failure`, or `Success`.
 *
 * @category combinators
 * @since 4.0.0
 */
export const match: {
  <A, E, X, Y, Z>(options: {
    readonly onInitial: (_: Initial<A, E>) => X
    readonly onFailure: (_: Failure<A, E>) => Y
    readonly onSuccess: (_: Success<A, E>) => Z
  }): (self: AsyncResult<A, E>) => X | Y | Z
  <A, E, X, Y, Z>(self: AsyncResult<A, E>, options: {
    readonly onInitial: (_: Initial<A, E>) => X
    readonly onFailure: (_: Failure<A, E>) => Y
    readonly onSuccess: (_: Success<A, E>) => Z
  }): X | Y | Z
} = dual(2, <A, E, X, Y, Z>(self: AsyncResult<A, E>, options: {
  readonly onInitial: (_: Initial<A, E>) => X
  readonly onFailure: (_: Failure<A, E>) => Y
  readonly onSuccess: (_: Success<A, E>) => Z
}): X | Y | Z => {
  switch (self._tag) {
    case "Initial":
      return options.onInitial(self)
    case "Failure":
      return options.onFailure(self)
    case "Success":
      return options.onSuccess(self)
  }
})

/**
 * Pattern matches a result, handling successes and initials directly while splitting failures into typed errors or squashed non-error causes passed to `onDefect`.
 *
 * @category combinators
 * @since 4.0.0
 */
export const matchWithError: {
  <A, E, W, X, Y, Z>(options: {
    readonly onInitial: (_: Initial<A, E>) => W
    readonly onError: (error: E, _: Failure<A, E>) => X
    readonly onDefect: (defect: unknown, _: Failure<A, E>) => Y
    readonly onSuccess: (_: Success<A, E>) => Z
  }): (self: AsyncResult<A, E>) => W | X | Y | Z
  <A, E, W, X, Y, Z>(self: AsyncResult<A, E>, options: {
    readonly onInitial: (_: Initial<A, E>) => W
    readonly onError: (error: E, _: Failure<A, E>) => X
    readonly onDefect: (defect: unknown, _: Failure<A, E>) => Y
    readonly onSuccess: (_: Success<A, E>) => Z
  }): W | X | Y | Z
} = dual(2, <A, E, W, X, Y, Z>(self: AsyncResult<A, E>, options: {
  readonly onInitial: (_: Initial<A, E>) => W
  readonly onError: (error: E, _: Failure<A, E>) => X
  readonly onDefect: (defect: unknown, _: Failure<A, E>) => Y
  readonly onSuccess: (_: Success<A, E>) => Z
}): W | X | Y | Z => {
  switch (self._tag) {
    case "Initial":
      return options.onInitial(self)
    case "Failure": {
      const result = Cause.findError(self.cause)
      if (Result.isFailure(result)) {
        return options.onDefect(Cause.squash(result.failure), self)
      }
      return options.onError(result.success, self)
    }
    case "Success":
      return options.onSuccess(self)
  }
})

/**
 * Pattern matches a result by calling `onWaiting` for waiting or initial states, otherwise handling successes and splitting failures into typed errors or squashed non-error causes.
 *
 * @category combinators
 * @since 4.0.0
 */
export const matchWithWaiting: {
  <A, E, W, X, Y, Z>(options: {
    readonly onWaiting: (_: AsyncResult<A, E>) => W
    readonly onError: (error: E, _: Failure<A, E>) => X
    readonly onDefect: (defect: unknown, _: Failure<A, E>) => Y
    readonly onSuccess: (_: Success<A, E>) => Z
  }): (self: AsyncResult<A, E>) => W | X | Y | Z
  <A, E, W, X, Y, Z>(self: AsyncResult<A, E>, options: {
    readonly onWaiting: (_: AsyncResult<A, E>) => W
    readonly onError: (error: E, _: Failure<A, E>) => X
    readonly onDefect: (defect: unknown, _: Failure<A, E>) => Y
    readonly onSuccess: (_: Success<A, E>) => Z
  }): W | X | Y | Z
} = dual(2, <A, E, W, X, Y, Z>(self: AsyncResult<A, E>, options: {
  readonly onWaiting: (_: AsyncResult<A, E>) => W
  readonly onError: (error: E, _: Failure<A, E>) => X
  readonly onDefect: (defect: unknown, _: Failure<A, E>) => Y
  readonly onSuccess: (_: Success<A, E>) => Z
}): W | X | Y | Z => {
  if (self.waiting) {
    return options.onWaiting(self)
  }
  switch (self._tag) {
    case "Initial":
      return options.onWaiting(self)
    case "Failure": {
      const e = Cause.findError(self.cause)
      if (Result.isFailure(e)) {
        return options.onDefect(Cause.squash(e.failure), self)
      }
      return options.onError(e.success, self)
    }
    case "Success":
      return options.onSuccess(self)
  }
})

/**
 * Combines an iterable or record of `AsyncResult` and plain values into one `AsyncResult`, returning the first non-success result or a success of the collected values marked waiting when any input success is waiting.
 *
 * @category combinators
 * @since 4.0.0
 */
export const all = <const Arg extends Iterable<any> | Record<string, any>>(
  results: Arg
): AsyncResult<
  [Arg] extends [ReadonlyArray<any>] ? {
      -readonly [K in keyof Arg]: [Arg[K]] extends [AsyncResult<infer _A, infer _E>] ? _A : Arg[K]
    }
    : [Arg] extends [Iterable<infer _A>] ? _A extends AsyncResult<infer _AA, infer _E> ? _AA : _A
    : [Arg] extends [Record<string, any>] ? {
        -readonly [K in keyof Arg]: [Arg[K]] extends [AsyncResult<infer _A, infer _E>] ? _A : Arg[K]
      }
    : never,
  [Arg] extends [ReadonlyArray<any>] ? AsyncResult.Failure<Arg[number]>
    : [Arg] extends [Iterable<infer _A>] ? AsyncResult.Failure<_A>
    : [Arg] extends [Record<string, any>] ? AsyncResult.Failure<Arg[keyof Arg]>
    : never
> => {
  const isIter = isIterable(results)
  const entries = isIter
    ? Array.from(results, (result, i) => [i, result] as const)
    : Object.entries(results)
  const successes: any = isIter ? [] : {}
  let waiting = false
  for (let i = 0; i < entries.length; i++) {
    const [key, result] = entries[i]
    if (!isAsyncResult(result)) {
      successes[key] = result
      continue
    } else if (!isSuccess(result)) {
      return result as any
    }
    successes[key] = result.value
    if (result.waiting) {
      waiting = true
    }
  }
  return success(successes, { waiting }) as any
}

/**
 * Creates a typed builder for rendering an `AsyncResult` by handling waiting, initial, success, error, defect, interrupt, and failure cases.
 *
 * @category Builder
 * @since 4.0.0
 */
export const builder = <A extends AsyncResult<any, any>>(self: A): Builder<
  never,
  A extends Success<infer _A, infer _E> ? _A : never,
  A extends Failure<infer _A, infer _E> ? _E : never,
  A extends Initial<infer _A, infer _E> ? true : never,
  A extends Failure<infer _A, infer _E> ? Defect | Interrupt : never
> => new BuilderImpl(self) as any

/**
 * Type marker used by `Builder` to track whether defect failures still need to be handled.
 *
 * @category Builder
 * @since 4.0.0
 */
export interface Defect {
  readonly _: unique symbol
}

/**
 * Type marker used by `Builder` to track whether interrupt failures still need to be handled.
 *
 * @category Builder
 * @since 4.0.0
 */
export interface Interrupt {
  readonly _: unique symbol
}

/**
 * Fluent renderer for `AsyncResult` values that tracks unhandled cases at the type level and exposes `exhaustive` only after all possible cases are handled.
 *
 * @category Builder
 * @since 4.0.0
 */
export type Builder<Out, A, E, I, F> =
  & Pipeable
  & {
    onWaiting<B>(f: (result: AsyncResult<A, E>) => B): Builder<Out | B, A, E, I, F>
    orElse<B>(orElse: LazyArg<B>): Out | B
    orNull(): Out | null
    render(): [A | I] extends [never] ? Out : Out | null
  }
  & ([A | E | I | F] extends [never] ? {
      exhaustive(): Out
    } :
    unknown)
  & ([I] extends [never] ? unknown :
    {
      onInitial<B>(f: (result: Initial<A, E>) => B): Builder<Out | B, A, E, never, F>
      onInitialOrWaiting<B>(f: (result: AsyncResult<A, E>) => B): Builder<Out | B, A, E, never, F>
    })
  & ([A] extends [never] ? unknown :
    {
      onSuccess<B>(f: (value: A, result: Success<A, E>) => B): Builder<Out | B, never, E, I, F>
    })
  & ([E] extends [never] ? unknown : {
    onError<B>(f: (error: E, result: Failure<A, E>) => B): Builder<Out | B, A, never, I, F>

    onErrorIf<B extends E, C>(
      refinement: Refinement<E, B>,
      f: (error: B, result: Failure<A, E>) => C
    ): Builder<Out | C, A, Types.EqualsWith<E, B, E, Exclude<E, B>>, I, F>
    onErrorIf<C>(
      predicate: Predicate<E>,
      f: (error: E, result: Failure<A, E>) => C
    ): Builder<Out | C, A, E, I, F>

    onErrorTag<const Tags extends ReadonlyArray<Types.Tags<E>>, B>(
      tags: Tags,
      f: (error: Types.ExtractTag<E, Tags[number]>, result: Failure<A, E>) => B
    ): Builder<Out | B, A, Types.ExcludeTag<E, Tags[number]>, I, F>
    onErrorTag<const Tag extends Types.Tags<E>, B>(
      tag: Tag,
      f: (error: Types.ExtractTag<E, Tag>, result: Failure<A, E>) => B
    ): Builder<Out | B, A, Types.ExcludeTag<E, Tag>, I, F>
  })
  & ([E | F] extends [never] ? unknown : {
    onFailure<B>(f: (cause: Cause.Cause<E>, result: Failure<A, E>) => B): Builder<Out | B, A, never, I, never>
  })
  & (Interrupt extends F ? {
      onInterrupt<B>(
        f: (interruptors: ReadonlySet<number>, result: Failure<A, E>) => B
      ): Builder<Out | B, A, E, I, Exclude<F, Interrupt>>
    } :
    unknown)
  & (Defect extends F ? {
      onDefect<B>(f: (defect: unknown, result: Failure<A, E>) => B): Builder<Out | B, A, E, I, Exclude<F, Defect>>
    } :
    unknown)

class BuilderImpl<Out, A, E> {
  constructor(result: AsyncResult<A, E>) {
    this.result = result
  }
  readonly result: AsyncResult<A, E>
  public output = Option.none<Out>()

  when<B extends AsyncResult<A, E>, C>(
    refinement: Refinement<AsyncResult<A, E>, B>,
    f: (result: B) => Option.Option<C>
  ): any
  when<C>(
    refinement: Predicate<AsyncResult<A, E>>,
    f: (result: AsyncResult<A, E>) => Option.Option<C>
  ): any
  when<C>(
    refinement: Predicate<AsyncResult<A, E>>,
    f: (result: AsyncResult<A, E>) => Option.Option<C>
  ): any {
    if (Option.isNone(this.output) && refinement(this.result)) {
      const b = f(this.result)
      if (Option.isSome(b)) {
        ;(this as any).output = b
      }
    }
    return this
  }

  pipe() {
    return pipeArguments(this, arguments)
  }

  onWaiting<B>(f: (result: AsyncResult<A, E>) => B): BuilderImpl<Out | B, A, E> {
    return this.when((r) => r.waiting, (r) => Option.some(f(r)))
  }

  onInitialOrWaiting<B>(f: (result: AsyncResult<A, E>) => B): BuilderImpl<Out | B, A, E> {
    return this.when((r) => isInitial(r) || r.waiting, (r) => Option.some(f(r)))
  }

  onInitial<B>(f: (result: Initial<A, E>) => B): BuilderImpl<Out | B, A, E> {
    return this.when(isInitial, (r) => Option.some(f(r)))
  }

  onSuccess<B>(f: (value: A, result: Success<A, E>) => B): BuilderImpl<Out | B, never, E> {
    return this.when(isSuccess, (r) => Option.some(f(r.value, r)))
  }

  onFailure<B>(f: (cause: Cause.Cause<E>, result: Failure<A, E>) => B): BuilderImpl<Out | B, A, never> {
    return this.when(isFailure, (r) => Option.some(f(r.cause, r)))
  }

  onError<B>(f: (error: E, result: Failure<A, E>) => B): BuilderImpl<Out | B, A, never> {
    return this.onErrorIf(constTrue, f) as any
  }

  onErrorIf<C, B extends E = E>(
    refinement: Refinement<E, B> | Predicate<E>,
    f: (error: B, result: Failure<A, E>) => C
  ): BuilderImpl<Out | C, A, Types.EqualsWith<E, B, E, Exclude<E, B>>> {
    return this.when(isFailure, (result) =>
      Cause.findErrorOption(result.cause).pipe(
        Option.filter(refinement),
        Option.map((error) => f(error as B, result))
      ))
  }

  onErrorTag<B>(
    tag: string | ReadonlyArray<string>,
    f: (error: Types.ExtractTag<E, any>, result: Failure<A, E>) => B
  ): BuilderImpl<Out | B, A, Types.ExcludeTag<E, any>> {
    return this.onErrorIf(
      (e) => hasProperty(e, "_tag") && (Array.isArray(tag) ? tag.includes(e._tag) : e._tag === tag),
      f
    ) as any
  }

  onDefect<B>(f: (defect: unknown, result: Failure<A, E>) => B): BuilderImpl<Out | B, A, E> {
    return this.when(isFailure, (result) => {
      const defect = Cause.findDefect(result.cause)
      return Result.isFailure(defect) ? Option.none() : Option.some(f(defect.success, result))
    })
  }

  onInterrupt<B>(f: (interruptors: ReadonlySet<number>, result: Failure<A, E>) => B): BuilderImpl<Out | B, A, E> {
    return this.when(isFailure, (result) => {
      const interruptors = Cause.filterInterruptors(result.cause)
      return Result.isFailure(interruptors) ? Option.none() : Option.some(f(interruptors.success, result))
    })
  }

  orElse<B>(orElse: LazyArg<B>): Out | B {
    return Option.getOrElse(this.output, orElse)
  }

  orNull(): Out | null {
    return Option.getOrNull(this.output)
  }

  render(): Out | null {
    if (Option.isSome(this.output)) {
      return this.output.value
    } else if (isFailure(this.result)) {
      throw Cause.squash(this.result.cause)
    }
    return null
  }

  exhaustive(): Out {
    return this.render() as Out
  }
}

/**
 * Schema interface for `AsyncResult` values, retaining the schemas used for success values and failure errors.
 *
 * @category schemas
 * @since 4.0.0
 */
export interface Schema<
  Success extends Schema_.Top,
  Error extends Schema_.Top
> extends
  Schema_.declareConstructor<
    AsyncResult<Success["Type"], Error["Type"]>,
    AsyncResult<Success["Encoded"], Error["Encoded"]>,
    readonly [Success, Schema_.Cause<Error, Schema_.Defect>]
  >
{
  readonly success: Success
  readonly error: Error
}

/**
 * Creates a schema for `AsyncResult` values using optional schemas for success values and failure errors.
 *
 * @category schemas
 * @since 4.0.0
 */
export const Schema = <
  A extends Schema_.Top = Schema_.Never,
  E extends Schema_.Top = Schema_.Never
>(
  options: {
    readonly success?: A | undefined
    readonly error?: E | undefined
  }
): Schema<A, E> => {
  const success_: A = options.success ?? Schema_.Never as any
  const error: E = options.error ?? Schema_.Never as any
  const schema = Schema_.declareConstructor<
    AsyncResult<A["Type"], E["Type"]>,
    AsyncResult<A["Encoded"], E["Encoded"]>
  >()(
    [success_, Schema_.Cause(error, Schema_.Defect)],
    ([value, cause]) => (input, ast, options) => {
      if (!isAsyncResult(input)) {
        return Effect.fail(new SchemaIssue.InvalidType(ast, Option.some(input)))
      }
      switch (input._tag) {
        case "Initial":
          return Effect.succeed(input)
        case "Success":
          return Effect.mapBothEager(
            SchemaParser.decodeUnknownEffect(value)(input.value, options),
            {
              onSuccess: (value) => success(value, input),
              onFailure: (issue) =>
                new SchemaIssue.Composite(ast, Option.some(input), [new SchemaIssue.Pointer(["value"], issue)])
            }
          )
        case "Failure": {
          const prevSuccessEffect = input.previousSuccess.pipe(
            Option.map((ps) =>
              Effect.mapBothEager(
                SchemaParser.decodeUnknownEffect(value)(ps.value, options),
                {
                  onSuccess: (value) => Option.some(success<A["Type"], E["Type"]>(value, ps)),
                  onFailure: (issue) =>
                    new SchemaIssue.Composite(ast, Option.some(input), [
                      new SchemaIssue.Pointer(["previousSuccess", "value"], issue)
                    ])
                }
              )
            ),
            Option.getOrElse(() => Effect.succeedNone)
          )
          const causeEffect = Effect.mapErrorEager(
            SchemaParser.decodeUnknownEffect(cause)(input.cause, options),
            (issue) => new SchemaIssue.Composite(ast, Option.some(input), [new SchemaIssue.Pointer(["cause"], issue)])
          )
          return Effect.flatMapEager(
            prevSuccessEffect,
            (previousSuccess) =>
              Effect.mapEager(causeEffect, (cause) =>
                failure(cause, {
                  previousSuccess,
                  waiting: input.waiting
                }))
          )
        }
      }
    },
    {
      expected: "AsyncResult",
      toCodec([value, cause]) {
        const Success = Schema_.TaggedStruct("Success", { value, waiting: Schema_.Boolean, timestamp: Schema_.Number })
        return Schema_.link<AsyncResult<A["Encoded"], E["Encoded"]>>()(
          Schema_.Union([
            Schema_.TaggedStruct("Initial", { waiting: Schema_.Boolean }),
            Success,
            Schema_.TaggedStruct("Failure", {
              cause,
              previousSuccess: Schema_.Option(Success),
              waiting: Schema_.Boolean
            })
          ]),
          SchemaTransformation.transform({
            decode: (encoded): AsyncResult<A["Encoded"], E["Encoded"]> => {
              switch (encoded._tag) {
                case "Initial":
                  return initial(encoded.waiting)
                case "Success":
                  return success(encoded.value, {
                    waiting: encoded.waiting,
                    timestamp: encoded.timestamp
                  })
                case "Failure": {
                  return failure(encoded.cause, {
                    previousSuccess: Option.map(encoded.previousSuccess, (ps) => success(ps.value, ps)),
                    waiting: encoded.waiting
                  })
                }
              }
            },
            encode(result) {
              switch (result._tag) {
                case "Initial":
                  return { _tag: "Initial" as const, waiting: result.waiting }
                case "Success":
                  return {
                    _tag: "Success" as const,
                    value: result.value,
                    waiting: result.waiting,
                    timestamp: result.timestamp
                  }
                case "Failure":
                  return {
                    _tag: "Failure" as const,
                    cause: result.cause,
                    previousSuccess: result.previousSuccess,
                    waiting: result.waiting
                  }
              }
            }
          })
        )
      },
      toEquivalence: Equal.asEquivalence,
      toFormatter: ([value, cause]) => (t) => {
        switch (t._tag) {
          case "Success":
            return `AsyncResult.Success(${value(t.value)}, ${t.waiting}, ${t.timestamp})`
          case "Failure":
            return `AsyncResult.Failure(${cause(t.cause)}, ${t.waiting})`
          case "Initial":
            return `AsyncResult.Initial(${t.waiting}, ${t.waiting})`
        }
      }
    }
  )
  return Object.assign(schema, {
    success: success_,
    error
  })
}

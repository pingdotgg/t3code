/**
 * Structured representation of how an Effect can fail.
 *
 * A `Cause<E>` holds a flat array of `Reason` values, where each reason is one of:
 *
 * - **Fail** — a typed, expected error `E` (created by `Effect.fail`)
 * - **Die** — an untyped defect (`unknown`) from `Effect.die` or uncaught throws
 * - **Interrupt** — a fiber interruption, optionally carrying the interrupting fiber's ID
 *
 * ## Mental model
 *
 * - A `Cause` is always flat: concurrent and sequential failures are stored together
 *   in `cause.reasons` (a `ReadonlyArray<Reason<E>>`).
 * - Each `Reason` carries an `annotations` map with tracing metadata (stack frames, spans).
 * - An empty `reasons` array means the computation succeeded or the cause was empty
 *   ({@link empty}).
 * - `Cause` implements `Equal`, so two causes with identical reasons compare as equal.
 *
 * ## Common tasks
 *
 * | Intent | API |
 * |--------|-----|
 * | Create a cause | {@link fail}, {@link die}, {@link interrupt}, {@link fromReasons} |
 * | Test for reason types | {@link hasFails}, {@link hasDies}, {@link hasInterrupts} |
 * | Extract the first error/defect | {@link findError}, {@link findDefect}, {@link findFail}, {@link findDie} |
 * | Iterate over reasons manually | `cause.reasons.filter(Cause.isFailReason)` |
 * | Combine two causes | {@link combine} |
 * | Transform errors | {@link map} |
 * | Collapse to a single thrown value | {@link squash} |
 * | Render for logging | {@link pretty}, {@link prettyErrors} |
 * | Attach/read tracing metadata | {@link annotate}, {@link annotations}, {@link reasonAnnotations} |
 *
 * ## Gotchas
 *
 * - `findError`/`findDefect` return `Result.fail` (not `Option.none`) when no match is
 *   found. Use {@link findErrorOption} if you need an `Option`.
 * - `squash` picks the first `Fail` error, then the first `Die` defect, then falls back
 *   to a generic "interrupted" / "empty" error. It is lossy — use `prettyErrors` or
 *   iterate `reasons` directly when you need all failures.
 * - The module also exports several built-in error classes (`NoSuchElementError`,
 *   `TimeoutError`, `IllegalArgumentError`, `ExceededCapacityError`, `UnknownError`)
 *   and the `Done` completion signal. These all implement `YieldableError` and can be
 *   yielded directly inside `Effect.gen`.
 *
 * **Example** (inspecting a concurrent failure)
 *
 * ```ts
 * import { Cause, Effect } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const cause = yield* Effect.sandbox(
 *     Effect.all([
 *       Effect.fail("err1"),
 *       Effect.die("defect"),
 *       Effect.fail("err2")
 *     ], { concurrency: "unbounded" })
 *   ).pipe(Effect.flip)
 *
 *   const errors = cause.reasons
 *     .filter(Cause.isFailReason)
 *     .map((r) => r.error)
 *     .sort()
 *
 *   const defects = cause.reasons
 *     .filter(Cause.isDieReason)
 *     .map((r) => String(r.defect))
 *     .sort()
 *
 *   console.log(errors.join(",")) // "err1,err2"
 *   console.log(defects.join(",")) // "defect"
 * })
 *
 * Effect.runPromise(program)
 * ```
 *
 * @since 2.0.0
 */
import * as Context from "./Context.ts"
import type * as Effect from "./Effect.ts"
import type { Equal } from "./Equal.ts"
import type { Fiber } from "./Fiber.ts"
import type { Inspectable } from "./Inspectable.ts"
import * as core from "./internal/core.ts"
import * as effect from "./internal/effect.ts"
import type { Option } from "./Option.ts"
import type { Pipeable } from "./Pipeable.ts"
import type { StackFrame } from "./References.ts"
import type * as Result from "./Result.ts"
import type * as Types from "./Types.ts"

/**
 * Unique brand for `Cause` values, used for runtime type checks via {@link isCause}.
 *
 * @category type IDs
 * @since 4.0.0
 */
export const TypeId: "~effect/Cause" = core.CauseTypeId

/**
 * Unique brand for `Reason` values, used for runtime type checks via {@link isReason}.
 *
 * @category type IDs
 * @since 4.0.0
 */
export const ReasonTypeId: "~effect/Cause/Reason" = core.CauseReasonTypeId

/**
 * A structured representation of how an Effect failed.
 *
 * **When to use**
 *
 * Use to preserve the full structured failure information for an effect instead
 * of collapsing it to a single error value.
 *
 * **Details**
 *
 * Access the individual failure entries through the `reasons` array, then
 * narrow each entry with {@link isFailReason}, {@link isDieReason}, or
 * {@link isInterruptReason}.
 *
 * - Use {@link hasFails} / {@link hasDies} / {@link hasInterrupts} to test
 *   for the presence of specific reason kinds without iterating.
 * - Use {@link findError} / {@link findDefect} to extract the first value
 *   of a given kind.
 * - Use {@link combine} to merge two causes.
 *
 * `Cause` implements `Equal` — two causes with the same reasons (by value)
 * compare as equal.
 *
 * **Example** (creating and inspecting a cause)
 *
 * ```ts
 * import { Cause } from "effect"
 *
 * const cause = Cause.fail("Something went wrong")
 * console.log(cause.reasons.length) // 1
 * console.log(Cause.isFailReason(cause.reasons[0])) // true
 * ```
 *
 * @category models
 * @since 2.0.0
 */
export interface Cause<out E> extends Pipeable, Inspectable, Equal {
  readonly [TypeId]: typeof TypeId
  readonly reasons: ReadonlyArray<Reason<E>>
}

/**
 * Checks whether an arbitrary value is a `Cause`.
 *
 * **Example** (runtime type check)
 *
 * ```ts
 * import { Cause } from "effect"
 *
 * console.log(Cause.isCause(Cause.fail("error"))) // true
 * console.log(Cause.isCause("not a cause")) // false
 * ```
 *
 * @category guards
 * @since 2.0.0
 */
export const isCause: (self: unknown) => self is Cause<unknown> = core.isCause

/**
 * Checks whether an arbitrary value is a `Reason` (`Fail`, `Die`, or `Interrupt`).
 *
 * **Example** (runtime type check)
 *
 * ```ts
 * import { Cause } from "effect"
 *
 * const reason = Cause.fail("error").reasons[0]
 * console.log(Cause.isReason(reason)) // true
 * console.log(Cause.isReason("not a reason")) // false
 * ```
 *
 * @category guards
 * @since 4.0.0
 */
export const isReason: (self: unknown) => self is Reason<unknown> = core.isCauseReason

/**
 * A single entry inside a `Cause`'s `reasons` array.
 *
 * **Details**
 *
 * Narrow to a concrete type with {@link isFailReason}, {@link isDieReason},
 * or {@link isInterruptReason}.
 *
 * - `Fail<E>` — typed error, access via `.error`
 * - `Die` — untyped defect, access via `.defect`
 * - `Interrupt` — fiber interruption, access via `.fiberId`
 *
 * Every reason carries an `annotations` map and an `annotate` method for
 * attaching tracing metadata.
 *
 * **Example** (narrowing a reason)
 *
 * ```ts
 * import { Cause } from "effect"
 *
 * const reason = Cause.fail("error").reasons[0]
 * if (Cause.isFailReason(reason)) {
 *   console.log(reason.error) // "error"
 * }
 * ```
 *
 * @category models
 * @since 4.0.0
 */
export type Reason<E> = Fail<E> | Die | Interrupt

/**
 * Narrows a `Reason` to `Fail`.
 *
 * **When to use**
 *
 * Use as a predicate for `Array.filter` to pick out typed `Fail` reasons when
 * iterating over `cause.reasons`.
 *
 * **Example** (filtering fail reasons)
 *
 * ```ts
 * import { Cause } from "effect"
 *
 * const cause = Cause.fail("error")
 * const fails = cause.reasons.filter(Cause.isFailReason)
 * console.log(fails[0].error) // "error"
 * ```
 *
 * @see {@link isDieReason} — narrow to `Die`
 * @see {@link isInterruptReason} — narrow to `Interrupt`
 *
 * @category guards
 * @since 4.0.0
 */
export const isFailReason: <E>(self: Reason<E>) => self is Fail<E> = core.isFailReason

/**
 * Narrows a `Reason` to `Die`.
 *
 * **When to use**
 *
 * Use as a predicate for `Array.filter` to pick out `Die` (defect) reasons when
 * iterating over `cause.reasons`.
 *
 * **Example** (filtering die reasons)
 *
 * ```ts
 * import { Cause } from "effect"
 *
 * const cause = Cause.die("defect")
 * const dies = cause.reasons.filter(Cause.isDieReason)
 * console.log(dies[0].defect) // "defect"
 * ```
 *
 * @see {@link isFailReason} — narrow to `Fail`
 * @see {@link isInterruptReason} — narrow to `Interrupt`
 *
 * @category guards
 * @since 4.0.0
 */
export const isDieReason: <E>(self: Reason<E>) => self is Die = core.isDieReason

/**
 * Narrows a `Reason` to `Interrupt`.
 *
 * **When to use**
 *
 * Use as a predicate for `Array.filter` to pick out `Interrupt` reasons when
 * iterating over `cause.reasons`.
 *
 * **Example** (filtering interrupt reasons)
 *
 * ```ts
 * import { Cause } from "effect"
 *
 * const cause = Cause.interrupt(123)
 * const interrupts = cause.reasons.filter(Cause.isInterruptReason)
 * console.log(interrupts[0].fiberId) // 123
 * ```
 *
 * @see {@link isFailReason} — narrow to `Fail`
 * @see {@link isDieReason} — narrow to `Die`
 *
 * @category guards
 * @since 4.0.0
 */
export const isInterruptReason: <E>(self: Reason<E>) => self is Interrupt = core.isInterruptReason

/**
 * Companion namespace for the `Cause` interface.
 *
 * @since 2.0.0
 */
export declare namespace Cause {
  /**
   * Extracts the error type `E` from a `Cause<E>`.
   *
   * **Example** (extracting the error type)
   *
   * ```ts
   * import type { Cause } from "effect"
   *
   * // string
   * type E = Cause.Cause.Error<Cause.Cause<string>>
   * ```
   *
   * @category models
   * @since 4.0.0
   */
  export type Error<T> = T extends Cause<infer E> ? E : never

  /**
   * Base interface shared by all reason types (`Fail`, `Die`, `Interrupt`).
   *
   * **Details**
   *
   * Every reason carries:
   * - `_tag` — discriminant string (`"Fail"`, `"Die"`, or `"Interrupt"`)
   * - `annotations` — tracing metadata attached by the runtime
   * - `annotate()` — returns a copy with additional annotations
   *
   * @category models
   * @since 4.0.0
   */
  export interface ReasonProto<Tag extends string> extends Inspectable, Equal {
    readonly [ReasonTypeId]: typeof ReasonTypeId
    readonly _tag: Tag
    readonly annotations: ReadonlyMap<string, unknown>
    annotate(annotations: Context.Context<never> | ReadonlyMap<string, unknown>, options?: {
      readonly overwrite?: boolean | undefined
    }): this
  }
}

/**
 * Companion namespace for the `Reason` type.
 *
 * @since 4.0.0
 */
export declare namespace Reason {
  /**
   * Extracts the error type `E` from a `Reason<E>`.
   *
   * **Example** (extracting the error type)
   *
   * ```ts
   * import type { Cause } from "effect"
   *
   * // string
   * type E = Cause.Reason.Error<Cause.Reason<string>>
   * ```
   *
   * @category models
   * @since 4.0.0
   */
  export type Error<T> = T extends Reason<infer E> ? E : never
}

/**
 * An untyped defect — typically a programming error or an uncaught exception.
 *
 * **When to use**
 *
 * Use when inspecting `Cause` reasons that represent defects instead of typed
 * failures or interruptions.
 *
 * **Details**
 *
 * The `defect` property is `unknown` because defects are not part of the
 * typed error channel. Use {@link isDieReason} to narrow a `Reason`
 * to this type.
 *
 * **Example** (accessing the defect)
 *
 * ```ts
 * import { Cause } from "effect"
 *
 * const cause = Cause.die("Unexpected")
 * const reason = cause.reasons[0]
 * if (Cause.isDieReason(reason)) {
 *   console.log(reason.defect) // "Unexpected"
 * }
 * ```
 *
 * @see {@link die} for constructing a cause with a single `Die` reason
 * @see {@link isDieReason} for narrowing a `Reason` to `Die`
 *
 * @category models
 * @since 2.0.0
 */
export interface Die extends Cause.ReasonProto<"Die"> {
  readonly defect: unknown
}

/**
 * A typed, expected error produced by `Effect.fail`.
 *
 * **When to use**
 *
 * Use when inspecting `Cause` reasons that represent expected failures from the
 * typed error channel.
 *
 * **Details**
 *
 * The `error` property carries the typed value `E`. Use {@link isFailReason}
 * to narrow a `Reason` to this type.
 *
 * **Example** (accessing the error)
 *
 * ```ts
 * import { Cause } from "effect"
 *
 * const cause = Cause.fail("Something went wrong")
 * const reason = cause.reasons[0]
 * if (Cause.isFailReason(reason)) {
 *   console.log(reason.error) // "Something went wrong"
 * }
 * ```
 *
 * @see {@link fail} for constructing a cause with a single `Fail` reason
 * @see {@link isFailReason} for narrowing a `Reason` to `Fail`
 *
 * @category models
 * @since 2.0.0
 */
export interface Fail<out E> extends Cause.ReasonProto<"Fail"> {
  readonly error: E
}

/**
 * A fiber interruption signal, optionally carrying the ID of the fiber that
 * initiated the interruption.
 *
 * **Details**
 *
 * Use {@link isInterruptReason} to narrow a `Reason` to this type.
 *
 * **Example** (accessing the fiber ID)
 *
 * ```ts
 * import { Cause } from "effect"
 *
 * const cause = Cause.interrupt(123)
 * const reason = cause.reasons[0]
 * if (Cause.isInterruptReason(reason)) {
 *   console.log(reason.fiberId) // 123
 * }
 * ```
 *
 * @category models
 * @since 2.0.0
 */
export interface Interrupt extends Cause.ReasonProto<"Interrupt"> {
  readonly fiberId: number | undefined
}

/**
 * Creates a `Cause` from an array of `Reason` values.
 *
 * **When to use**
 *
 * Use when you already have individual reasons (e.g. from filtering or
 * transforming another cause's `reasons` array) and need to wrap them back
 * into a `Cause`.
 *
 * **Details**
 *
 * - Returns a new `Cause`.
 * - An empty array produces a cause equivalent to `empty`.
 *
 * **Gotchas**
 *
 * The `reasons` array is stored as provided. Treat the array as immutable
 * after passing it to this function.
 *
 * **Example** (building a cause from reasons)
 *
 * ```ts
 * import { Cause } from "effect"
 *
 * const reasons = [
 *   Cause.makeFailReason("err1"),
 *   Cause.makeFailReason("err2")
 * ]
 * const cause = Cause.fromReasons(reasons)
 * console.log(cause.reasons.length) // 2
 * ```
 *
 * @see {@link combine} — merge two existing causes
 *
 * @category constructors
 * @since 4.0.0
 */
export const fromReasons: <E>(
  reasons: ReadonlyArray<Reason<E>>
) => Cause<E> = core.causeFromReasons

/**
 * Represents a `Cause` with an empty `reasons` array.
 *
 * **When to use**
 *
 * Use to represent the absence of failure when constructing or combining
 * causes.
 *
 * **Details**
 *
 * Represents the absence of failure. Combining any cause with `empty` via
 * {@link combine} returns the original cause unchanged.
 *
 * **Example** (combining with the empty cause)
 *
 * ```ts
 * import { Cause } from "effect"
 *
 * const cause = Cause.combine(Cause.empty, Cause.fail("boom"))
 *
 * console.log(cause.reasons.length) // 1
 * console.log(Cause.hasFails(cause)) // true
 * ```
 *
 * @see {@link combine} for merging causes where `empty` acts as the identity
 *
 * @category constructors
 * @since 2.0.0
 */
export const empty: Cause<never> = core.causeEmpty

/**
 * Creates a `Cause` containing a single `Fail` reason with the
 * given typed error.
 *
 * **When to use**
 *
 * Use to construct a cause from an expected typed error.
 *
 * **Example** (creating a fail cause)
 *
 * ```ts
 * import { Cause } from "effect"
 *
 * const cause = Cause.fail("Something went wrong")
 * console.log(cause.reasons.length) // 1
 * console.log(Cause.isFailReason(cause.reasons[0])) // true
 * ```
 *
 * @see {@link die} — for untyped defects
 * @see {@link interrupt} — for fiber interruptions
 *
 * @category constructors
 * @since 2.0.0
 */
export const fail: <E>(error: E) => Cause<E> = core.causeFail

/**
 * Creates a `Cause` containing a single `Die` reason with the
 * given defect.
 *
 * **When to use**
 *
 * Use to construct a cause from an untyped defect or unexpected thrown value.
 *
 * **Example** (creating a die cause)
 *
 * ```ts
 * import { Cause } from "effect"
 *
 * const cause = Cause.die("Unexpected")
 * console.log(cause.reasons.length) // 1
 * console.log(Cause.isDieReason(cause.reasons[0])) // true
 * ```
 *
 * @see {@link fail} — for typed errors
 * @see {@link interrupt} — for fiber interruptions
 *
 * @category constructors
 * @since 2.0.0
 */
export const die: (defect: unknown) => Cause<never> = core.causeDie

/**
 * Creates a `Cause` containing a single `Interrupt` reason,
 * optionally carrying the interrupting fiber's ID.
 *
 * **Example** (creating an interrupt cause)
 *
 * ```ts
 * import { Cause } from "effect"
 *
 * const cause = Cause.interrupt(123)
 * console.log(cause.reasons.length) // 1
 * console.log(Cause.isInterruptReason(cause.reasons[0])) // true
 * ```
 *
 * @see {@link fail} — for typed errors
 * @see {@link die} — for untyped defects
 *
 * @category constructors
 * @since 2.0.0
 */
export const interrupt: (fiberId?: number | undefined) => Cause<never> = effect.causeInterrupt

/**
 * Creates a standalone `Fail` reason (not wrapped in a `Cause`).
 *
 * **When to use**
 *
 * Use when constructing a standalone typed failure reason for
 * {@link fromReasons} or direct comparison.
 *
 * **Example** (creating a Fail reason)
 *
 * ```ts
 * import { Cause } from "effect"
 *
 * const reason = Cause.makeFailReason("error")
 * console.log(reason._tag) // "Fail"
 * console.log(reason.error) // "error"
 * ```
 *
 * @see {@link makeDieReason} — create a `Die` reason
 * @see {@link makeInterruptReason} — create an `Interrupt` reason
 *
 * @category constructors
 * @since 4.0.0
 */
export const makeFailReason = <E>(error: E): Fail<E> => new core.Fail(error)

/**
 * Creates a standalone `Die` reason (not wrapped in a `Cause`).
 *
 * **When to use**
 *
 * Use when constructing a standalone defect reason for {@link fromReasons} or
 * direct comparison.
 *
 * **Example** (creating a Die reason)
 *
 * ```ts
 * import { Cause } from "effect"
 *
 * const reason = Cause.makeDieReason("bug")
 * console.log(reason._tag) // "Die"
 * console.log(reason.defect) // "bug"
 * ```
 *
 * @see {@link makeFailReason} — create a `Fail` reason
 * @see {@link makeInterruptReason} — create an `Interrupt` reason
 *
 * @category constructors
 * @since 4.0.0
 */
export const makeDieReason = (defect: unknown): Die => new core.Die(defect)

/**
 * Creates a standalone `Interrupt` reason (not wrapped in a `Cause`),
 * optionally carrying the interrupting fiber's ID.
 *
 * **When to use**
 *
 * Use when constructing a standalone interrupt reason for {@link fromReasons}
 * or direct comparison.
 *
 * **Example** (creating an Interrupt reason)
 *
 * ```ts
 * import { Cause } from "effect"
 *
 * const reason = Cause.makeInterruptReason(42)
 * console.log(reason._tag) // "Interrupt"
 * console.log(reason.fiberId) // 42
 * ```
 *
 * @see {@link makeFailReason} — create a `Fail` reason
 * @see {@link makeDieReason} — create a `Die` reason
 *
 * @category constructors
 * @since 4.0.0
 */
export const makeInterruptReason: (fiberId?: number | undefined) => Interrupt = effect.makeInterruptReason

/**
 * Returns `true` if every reason in the cause is an `Interrupt` (and
 * there is at least one reason).
 *
 * **When to use**
 *
 * Use when deciding whether a failure was entirely due to interruption and
 * can be silently discarded.
 *
 * **Example** (checking interrupt-only causes)
 *
 * ```ts
 * import { Cause } from "effect"
 *
 * console.log(Cause.hasInterruptsOnly(Cause.interrupt(123))) // true
 * console.log(Cause.hasInterruptsOnly(Cause.fail("error")))  // false
 * console.log(Cause.hasInterruptsOnly(Cause.empty))          // false
 * ```
 *
 * @see {@link hasInterrupts} — `true` if the cause contains *any* interrupts
 *
 * @category predicates
 * @since 4.0.0
 */
export const hasInterruptsOnly: <E>(self: Cause<E>) => boolean = effect.hasInterruptsOnly

/**
 * Transforms the typed error values inside a `Cause` using the
 * provided function. Only `Fail` reasons are affected; `Die` and `Interrupt`
 * reasons pass through unchanged.
 *
 * **When to use**
 *
 * Use to transform expected typed failures while preserving defects and
 * interruptions unchanged.
 *
 * **Details**
 *
 * If at least one `Fail` reason exists, this returns a new `Cause`
 * containing the mapped failures. If the cause has no `Fail` reasons, the
 * original cause is returned unchanged.
 *
 * **Example** (mapping errors to uppercase)
 *
 * ```ts
 * import { Cause } from "effect"
 *
 * const cause = Cause.fail("error")
 * const mapped = Cause.map(cause, (e) => e.toUpperCase())
 * const reason = mapped.reasons[0]
 * if (Cause.isFailReason(reason)) {
 *   console.log(reason.error) // "ERROR"
 * }
 * ```
 *
 * @category mapping
 * @since 2.0.0
 */
export const map: {
  <E, E2>(f: (error: Types.NoInfer<E>) => E2): (self: Cause<E>) => Cause<E2>
  <E, E2>(self: Cause<E>, f: (error: Types.NoInfer<E>) => E2): Cause<E2>
} = effect.causeMap

/**
 * Merges two causes into a single cause whose `reasons` array is the union
 * of both inputs (de-duplicated by value equality).
 *
 * **When to use**
 *
 * Use to merge independent causes into one structured failure value.
 *
 * **Details**
 *
 * - Combining with `empty` returns the other cause unchanged.
 * - If the result is structurally equal to `self`, `self` is returned
 *   (referential shortcut).
 *
 * **Example** (combining two causes)
 *
 * ```ts
 * import { Cause } from "effect"
 *
 * const cause1 = Cause.fail("error1")
 * const cause2 = Cause.fail("error2")
 * const combined = Cause.combine(cause1, cause2)
 * console.log(combined.reasons.length) // 2
 * ```
 *
 * @see {@link fromReasons} — build a cause from an array of reasons
 * @see {@link empty} for the identity cause used when combining
 *
 * @category combining
 * @since 4.0.0
 */
export const combine: {
  <E2>(that: Cause<E2>): <E>(self: Cause<E>) => Cause<E | E2>
  <E, E2>(self: Cause<E>, that: Cause<E2>): Cause<E | E2>
} = effect.causeCombine

/**
 * Collapses a `Cause` into a single `unknown` value, picking the "most
 * important" failure in this order:
 *
 * **When to use**
 *
 * Use to collapse a structured cause to the single value that synchronous and
 * promise runners would throw.
 *
 * **Details**
 *
 * 1. First `Fail` error (the `E` value)
 * 2. First `Die` defect
 * 3. A generic `Error("All fibers interrupted without error")` for interrupt-only causes
 * 4. A generic `Error("Empty cause")` for `empty`
 *
 * This is the function used by `Effect.runPromise` and `Effect.runSync` to
 * decide what to throw.
 *
 * **Gotchas**
 *
 * This function is lossy. Use {@link prettyErrors} or iterate `cause.reasons`
 * when you need all failures.
 *
 * **Example** (squashing a cause)
 *
 * ```ts
 * import { Cause } from "effect"
 *
 * console.log(Cause.squash(Cause.fail("error")))    // "error"
 * console.log(Cause.squash(Cause.die("defect")))    // "defect"
 * ```
 *
 * @see {@link prettyErrors} — non-lossy conversion to `Array<Error>`
 * @see {@link pretty} — human-readable string rendering
 *
 * @category destructors
 * @since 2.0.0
 */
export const squash: <E>(self: Cause<E>) => unknown = effect.causeSquash

/**
 * Returns `true` if the cause contains at least one `Fail` reason.
 *
 * **When to use**
 *
 * Use to check whether a cause includes typed failures before extracting,
 * mapping, or rendering them.
 *
 * **Example** (checking for typed errors)
 *
 * ```ts
 * import { Cause } from "effect"
 *
 * console.log(Cause.hasFails(Cause.fail("error"))) // true
 * console.log(Cause.hasFails(Cause.die("defect"))) // false
 * ```
 *
 * @see {@link hasDies} — check for defects
 * @see {@link hasInterrupts} — check for interruptions
 *
 * @category predicates
 * @since 4.0.0
 */
export const hasFails: <E>(self: Cause<E>) => boolean = effect.hasFails

/**
 * Returns a `Result` whose success value is the first `Fail` reason in
 * the cause, including its annotations. If the cause has no `Fail` reason, the
 * failure value is the original cause narrowed to `Cause<never>`, because it
 * contains no typed error reasons.
 *
 * **When to use**
 *
 * Use when you use {@link findError} if you only need the unwrapped error value `E`.
 *
 * **Example** (extracting the first Fail reason)
 *
 * ```ts
 * import { Cause, Result } from "effect"
 *
 * const result = Cause.findFail(Cause.fail("error"))
 * if (!Result.isFailure(result)) {
 *   console.log(result.success.error) // "error"
 * }
 * ```
 *
 * @see {@link findError} — extract the unwrapped `E` value
 * @see {@link findDie} — extract the first `Die` reason
 *
 * @category filtering
 * @since 4.0.0
 */
export const findFail: <E>(self: Cause<E>) => Result.Result<Fail<E>, Cause<never>> = effect.findFail

/**
 * Returns a `Result` whose success value is the first typed error value `E`
 * from a `Fail` reason in the cause. If the cause has no `Fail` reason,
 * the failure value is the original cause narrowed to `Cause<never>`, because
 * it contains no typed error reasons.
 *
 * **When to use**
 *
 * Use when you use {@link findFail} if you need the full `Fail` reason (including
 * annotations). Use {@link findErrorOption} if you prefer an `Option`.
 *
 * **Example** (extracting the first error value)
 *
 * ```ts
 * import { Cause, Result } from "effect"
 *
 * const result = Cause.findError(Cause.fail("error"))
 * if (!Result.isFailure(result)) {
 *   console.log(result.success) // "error"
 * }
 * ```
 *
 * @see {@link findFail} — extract the full `Fail` reason
 * @see {@link findErrorOption} — `Option`-based variant
 *
 * @category filtering
 * @since 4.0.0
 */
export const findError: <E>(self: Cause<E>) => Result.Result<E, Cause<never>> = effect.findError

/**
 * Returns the first typed error value `E` from a cause wrapped in
 * `Option.some`, or `Option.none` if no `Fail` reason exists.
 *
 * **When to use**
 *
 * Use when this is the `Option`-returning variant of {@link findError} for code that
 * does not need the original cause returned in a failed `Result`.
 *
 * **Example** (extracting an error as Option)
 *
 * ```ts
 * import { Cause, Option } from "effect"
 *
 * const some = Cause.findErrorOption(Cause.fail("error"))
 * console.log(Option.isSome(some)) // true
 *
 * const none = Cause.findErrorOption(Cause.die("defect"))
 * console.log(Option.isNone(none)) // true
 * ```
 *
 * @see {@link findError} — `Result`-based variant
 *
 * @category filtering
 * @since 4.0.0
 */
export const findErrorOption: <E>(input: Cause<E>) => Option<E> = effect.findErrorOption

/**
 * Returns `true` if the cause contains at least one `Die` reason.
 *
 * **When to use**
 *
 * Use to check whether a cause includes defects before extracting or rendering
 * them.
 *
 * **Example** (checking for defects)
 *
 * ```ts
 * import { Cause } from "effect"
 *
 * console.log(Cause.hasDies(Cause.die("defect"))) // true
 * console.log(Cause.hasDies(Cause.fail("error"))) // false
 * ```
 *
 * @see {@link hasFails} — check for typed errors
 * @see {@link hasInterrupts} — check for interruptions
 *
 * @category predicates
 * @since 4.0.0
 */
export const hasDies: <E>(self: Cause<E>) => boolean = effect.hasDies

/**
 * Returns a `Result` whose success value is the first `Die` reason in
 * the cause, including its annotations. If the cause has no `Die` reason, the
 * failure value is the original cause.
 *
 * **When to use**
 *
 * Use when you use {@link findDefect} if you only need the unwrapped defect value.
 *
 * **Example** (extracting the first Die reason)
 *
 * ```ts
 * import { Cause, Result } from "effect"
 *
 * const result = Cause.findDie(Cause.die("defect"))
 * if (!Result.isFailure(result)) {
 *   console.log(result.success.defect) // "defect"
 * }
 * ```
 *
 * @see {@link findDefect} — extract the unwrapped defect value
 * @see {@link findFail} — extract the first `Fail` reason
 *
 * @category filtering
 * @since 4.0.0
 */
export const findDie: <E>(self: Cause<E>) => Result.Result<Die, Cause<E>> = effect.findDie

/**
 * Returns a `Result` whose success value is the first defect value from a
 * `Die` reason in the cause. If the cause has no `Die` reason, the
 * failure value is the original cause.
 *
 * **When to use**
 *
 * Use when you use {@link findDie} if you need the full `Die` reason (including
 * annotations).
 *
 * **Example** (extracting the first defect)
 *
 * ```ts
 * import { Cause, Result } from "effect"
 *
 * const result = Cause.findDefect(Cause.die("defect"))
 * if (!Result.isFailure(result)) {
 *   console.log(result.success) // "defect"
 * }
 * ```
 *
 * @see {@link findDie} — extract the full `Die` reason
 * @see {@link findError} — extract the first typed error
 *
 * @category filtering
 * @since 4.0.0
 */
export const findDefect: <E>(self: Cause<E>) => Result.Result<unknown, Cause<E>> = effect.findDefect

/**
 * Returns `true` if the cause contains at least one `Interrupt` reason.
 *
 * **Example** (checking for interruptions)
 *
 * ```ts
 * import { Cause } from "effect"
 *
 * console.log(Cause.hasInterrupts(Cause.interrupt(123))) // true
 * console.log(Cause.hasInterrupts(Cause.fail("error")))  // false
 * ```
 *
 * @see {@link hasInterruptsOnly} — `true` only when *all* reasons are interrupts
 * @see {@link hasFails} — check for typed errors
 * @see {@link hasDies} — check for defects
 *
 * @category predicates
 * @since 4.0.0
 */
export const hasInterrupts: <E>(self: Cause<E>) => boolean = effect.hasInterrupts

/**
 * Returns a `Result` whose success value is the first `Interrupt` reason
 * in the cause, including its annotations. If the cause has no `Interrupt`
 * reason, the failure value is the original cause.
 *
 * **When to use**
 *
 * Use to extract the first interruption reason when you need its fiber ID and
 * annotations.
 *
 * **Example** (extracting the first interrupt)
 *
 * ```ts
 * import { Cause, Result } from "effect"
 *
 * const result = Cause.findInterrupt(Cause.interrupt(42))
 * if (!Result.isFailure(result)) {
 *   console.log(result.success.fiberId) // 42
 * }
 * ```
 *
 * @see {@link interruptors} — collect all interrupting fiber IDs as a `Set`
 *
 * @category filtering
 * @since 4.0.0
 */
export const findInterrupt: <E>(self: Cause<E>) => Result.Result<Interrupt, Cause<E>> = effect.findInterrupt

/**
 * Collects the defined fiber IDs from all `Interrupt` reasons in the
 * cause into a `ReadonlySet`. Interrupt reasons without a `fiberId` are
 * ignored. Returns an empty set when the cause has no interrupting fiber IDs.
 *
 * **When to use**
 *
 * Use when this always succeeds. Use {@link filterInterruptors} when you want a
 * `Result` that fails with the original cause if there are no `Interrupt`
 * reasons.
 *
 * **Example** (collecting interruptors)
 *
 * ```ts
 * import { Cause } from "effect"
 *
 * const cause = Cause.combine(
 *   Cause.interrupt(1),
 *   Cause.interrupt(2)
 * )
 *
 * console.log(Cause.interruptors(cause)) // Set(2) { 1, 2 }
 * ```
 *
 * @see {@link filterInterruptors} — `Result`-based variant
 *
 * @category accessors
 * @since 2.0.0
 */
export const interruptors: <E>(self: Cause<E>) => ReadonlySet<number> = effect.causeInterruptors

/**
 * Returns a `Result` whose success value is the set of defined fiber IDs from
 * the cause's `Interrupt` reasons. If the cause has no `Interrupt`
 * reason, the failure value is the original cause.
 *
 * **When to use**
 *
 * Use when you use {@link interruptors} if you always want a `Set` without `Result`
 * wrapping.
 *
 * **Gotchas**
 *
 * Interrupt reasons without a `fiberId` still count as interrupts, so the
 * function succeeds with an empty `Set` when every interrupt reason has an
 * undefined fiber ID.
 *
 * **Example** (extracting interruptors with Result)
 *
 * ```ts
 * import { Cause, Result } from "effect"
 *
 * const result = Cause.filterInterruptors(Cause.interrupt(1))
 * if (!Result.isFailure(result)) {
 *   console.log(result.success) // Set(1) { 1 }
 * }
 * ```
 *
 * @see {@link interruptors} — always-succeeding variant
 *
 * @category filtering
 * @since 4.0.0
 */
export const filterInterruptors: <E>(self: Cause<E>) => Result.Result<Set<number>, Cause<E>> =
  effect.causeFilterInterruptors

/**
 * Converts a `Cause` into an `Array<Error>` suitable for logging or
 * rethrowing.
 *
 * **When to use**
 *
 * Use to convert every renderable failure in a cause into individual `Error`
 * values before logging or rethrowing.
 *
 * **Details**
 *
 * Each `Fail` and `Die` reason is converted into a standard
 * `Error`:
 *
 * - **Objects / Error instances** — `message`, `name`, `stack`, and `cause`
 *   are preserved. Extra enumerable properties are copied. Stack traces are
 *   cleaned up and enriched with span annotations when available.
 * - **Strings** — used directly as the `Error` message.
 * - **Other primitives** (`null`, `undefined`, numbers, …) — wrapped in an
 *   `Error` with message `"Unknown error: <value>"`.
 *
 * `Interrupt` reasons are collected separately. If the cause contains
 * **only** interrupts (no `Fail` or `Die`), a single `InterruptError` is
 * returned whose `cause` lists the interrupting fiber IDs.
 *
 * An empty cause returns an empty array.
 *
 * **Example** (converting a cause to errors)
 *
 * ```ts
 * import { Cause } from "effect"
 *
 * const cause = Cause.fail(new Error("boom"))
 * const errors = Cause.prettyErrors(cause)
 * console.log(errors[0].message) // "boom"
 * ```
 *
 * @see {@link pretty} — renders the cause as a single string
 * @see {@link squash} — lossy collapse to a single thrown value
 *
 * @category rendering
 * @since 3.2.0
 */
export const prettyErrors: <E>(self: Cause<E>) => Array<Error> = effect.causePrettyErrors

/**
 * Formats a `Cause` as a human-readable string for logging or debugging.
 *
 * **When to use**
 *
 * Use to render a whole cause as one human-readable string for logs or
 * diagnostics.
 *
 * **Details**
 *
 * Delegates to {@link prettyErrors} to convert each reason to an `Error`,
 * then joins their stack traces with newlines. Nested `Error.cause` chains
 * are rendered inline with indentation:
 *
 * ```text
 * ErrorName: message
 *     at ...
 *     at ... {
 *   [cause]: NestedError: message
 *       at ...
 * }
 * ```
 *
 * Span annotations are appended to the relevant stack frames when available.
 *
 * **Gotchas**
 *
 * Rendering an empty cause produces an empty string because there are no
 * errors to render.
 *
 * **Example** (rendering a cause)
 *
 * ```ts
 * import { Cause } from "effect"
 *
 * const rendered = Cause.pretty(Cause.fail("something went wrong"))
 * console.log(rendered.includes("something went wrong")) // true
 * ```
 *
 * @see {@link prettyErrors} — get the individual `Error` instances
 *
 * @category rendering
 * @since 2.0.0
 */
export const pretty: <E>(cause: Cause<E>) => string = effect.causePretty

/**
 * Base interface for error classes that can be yielded directly inside
 * `Effect.gen`. Yielding one of these errors fails the generator with that
 * error as the typed failure value.
 *
 * **Details**
 *
 * All built-in error classes in this module (`NoSuchElementError`,
 * `TimeoutError`, `IllegalArgumentError`, `ExceededCapacityError`,
 * `AsyncFiberError`, and `UnknownError`) implement this interface.
 *
 * **Example** (yielding an error in Effect.gen)
 *
 * ```ts
 * import { Cause, Effect } from "effect"
 *
 * const error = new Cause.NoSuchElementError("not found")
 *
 * const program = Effect.gen(function*() {
 *   return yield* error // fails the effect with NoSuchElementError
 * })
 * ```
 *
 * @category errors
 * @since 2.0.0
 */
export interface YieldableError extends Error, Pipeable, Inspectable {
  readonly [Effect.TypeId]: Effect.Variance<never, this, never>
  [Symbol.iterator](): Effect.EffectIterator<Effect.Effect<never, this, never>>
}

/**
 * Checks whether an arbitrary value is a `NoSuchElementError`.
 *
 * **Example** (runtime type check)
 *
 * ```ts
 * import { Cause } from "effect"
 *
 * console.log(Cause.isNoSuchElementError(new Cause.NoSuchElementError())) // true
 * console.log(Cause.isNoSuchElementError("nope")) // false
 * ```
 *
 * @category guards
 * @since 4.0.0
 */
export const isNoSuchElementError: (u: unknown) => u is NoSuchElementError = core.isNoSuchElementError

/**
 * Unique brand for `NoSuchElementError`.
 *
 * @category type IDs
 * @since 4.0.0
 */
export const NoSuchElementErrorTypeId: "~effect/Cause/NoSuchElementError" = core.NoSuchElementErrorTypeId

/**
 * An error indicating that an expected value was absent.
 *
 * **When to use**
 *
 * Use to model APIs that intentionally turn absence into an error.
 *
 * **Details**
 *
 * Used by APIs that convert absence into an exception or effect failure, such
 * as `Option.getOrThrow`. Implements `YieldableError` so it can be
 * yielded directly in `Effect.gen`.
 *
 * **Gotchas**
 *
 * Prefer APIs that return `Option` or a typed failure when absence is an
 * expected case. This error is mainly for APIs that intentionally turn absence
 * into a thrown value or failed effect.
 *
 * **Example** (creating and checking)
 *
 * ```ts
 * import { Cause } from "effect"
 *
 * const error = new Cause.NoSuchElementError("Element not found")
 * console.log(error._tag)    // "NoSuchElementError"
 * console.log(error.message) // "Element not found"
 * ```
 *
 * @category errors
 * @since 4.0.0
 */
export interface NoSuchElementError extends YieldableError {
  readonly [NoSuchElementErrorTypeId]: typeof NoSuchElementErrorTypeId
  readonly _tag: "NoSuchElementError"
}

/**
 * Constructs a `NoSuchElementError` with an optional message.
 *
 * **When to use**
 *
 * Use to create the error value for APIs that intentionally fail when an
 * expected element is absent.
 *
 * **Example** (creating a NoSuchElementError)
 *
 * ```ts
 * import { Cause } from "effect"
 *
 * const error = new Cause.NoSuchElementError("Element not found")
 * console.log(error.message) // "Element not found"
 * ```
 *
 * @see {@link isNoSuchElementError} for checking unknown values
 *
 * @category constructors
 * @since 4.0.0
 */
export const NoSuchElementError: new(message?: string) => NoSuchElementError = core.NoSuchElementError

/**
 * Checks whether an arbitrary value is a `Done` signal.
 *
 * **Example** (runtime type check)
 *
 * ```ts
 * import { Cause } from "effect"
 *
 * console.log(Cause.isDone(Cause.Done())) // true
 * console.log(Cause.isDone("not done"))   // false
 * ```
 *
 * @category guards
 * @since 4.0.0
 */
export const isDone: (u: unknown) => u is Done<any> = core.isDone

/**
 * Unique brand for `Done` values.
 *
 * @category type IDs
 * @since 4.0.0
 */
export const DoneTypeId: "~effect/Cause/Done" = core.DoneTypeId

/**
 * A graceful completion signal for queues and streams.
 *
 * **When to use**
 *
 * Use to model normal producer completion through a stream or queue error
 * channel.
 *
 * **Details**
 *
 * `Done` indicates that a producer has finished normally — no more elements
 * will arrive. It is distinct from an error or interruption; it represents
 * successful completion. The optional `value` field can carry a final
 * leftover payload.
 *
 * **Example** (signaling queue completion)
 *
 * ```ts
 * import { Cause, Effect, Queue } from "effect"
 *
 * const program = Effect.gen(function*() {
 *   const queue = yield* Queue.bounded<number, Cause.Done>(10)
 *   yield* Queue.offer(queue, 1)
 *   yield* Queue.end(queue)
 *
 *   const result = yield* Effect.flip(Queue.take(queue))
 *   console.log(Cause.isDone(result)) // true
 * })
 * ```
 *
 * @category errors
 * @since 4.0.0
 */
export interface Done<A = void> {
  readonly [DoneTypeId]: typeof DoneTypeId
  readonly _tag: "Done"
  readonly value: A
}

/**
 * Companion namespace for the `Done` interface.
 *
 * @since 4.0.0
 */
export declare namespace Done {
  /**
   * Extracts the value type `A` from a `Done<A>` that may be nested in an
   * error union.
   *
   * @category utility types
   * @since 4.0.0
   */
  export type Extract<E> = E extends Done<infer L> ? L : never

  /**
   * Filters a type union to only keep `Done` members.
   *
   * @category filtering
   * @since 4.0.0
   */
  export type Only<E> = E extends Done<infer L> ? Done<L> : never
}

/**
 * Creates a `Done` signal with an optional value.
 *
 * **When to use**
 *
 * Use when you need the completion signal value itself. Use {@link done}
 * when you need an `Effect` that fails with the signal.
 *
 * @see {@link done} — create a failing `Effect` with `Done`
 *
 * @category constructors
 * @since 4.0.0
 */
export const Done: <A = void>(value?: A) => Done<A> = core.Done

/**
 * Creates an Effect that fails with a `Done` error. Shorthand for
 * `Effect.fail(Cause.Done(value))`.
 *
 * **When to use**
 *
 * Use when you use this in effect workflows that model stream or queue completion through
 * the error channel.
 *
 * **Example** (failing with Done)
 *
 * ```ts
 * import { Cause, Effect } from "effect"
 *
 * const program = Cause.done("finished")
 *
 * Effect.runPromiseExit(program).then((exit) => {
 *   console.log(exit._tag) // "Failure"
 * })
 * ```
 *
 * @see {@link Done} — create the signal value without an Effect
 *
 * @category constructors
 * @since 4.0.0
 */
export const done: <A = void>(value?: A) => Effect.Effect<never, Done<A>> = core.done

/**
 * Unique brand for `TimeoutError`.
 *
 * @category type IDs
 * @since 4.0.0
 */
export const TimeoutErrorTypeId: "~effect/Cause/TimeoutError" = effect.TimeoutErrorTypeId

/**
 * Checks whether an arbitrary value is a `TimeoutError`.
 *
 * **Example** (runtime type check)
 *
 * ```ts
 * import { Cause } from "effect"
 *
 * console.log(Cause.isTimeoutError(new Cause.TimeoutError())) // true
 * console.log(Cause.isTimeoutError("nope")) // false
 * ```
 *
 * @category guards
 * @since 4.0.0
 */
export const isTimeoutError: (u: unknown) => u is TimeoutError = effect.isTimeoutError

/**
 * An error indicating that an operation exceeded its time limit.
 *
 * **Details**
 *
 * Produced by `Effect.timeout` and related APIs. Implements
 * `YieldableError`.
 *
 * **Example** (creating and checking)
 *
 * ```ts
 * import { Cause } from "effect"
 *
 * const error = new Cause.TimeoutError("Operation timed out")
 * console.log(error._tag)    // "TimeoutError"
 * console.log(error.message) // "Operation timed out"
 * ```
 *
 * @category errors
 * @since 4.0.0
 */
export interface TimeoutError extends YieldableError {
  readonly [TimeoutErrorTypeId]: typeof TimeoutErrorTypeId
  readonly _tag: "TimeoutError"
}

/**
 * Constructs a `TimeoutError` with an optional message.
 *
 * **Example** (creating a TimeoutError)
 *
 * ```ts
 * import { Cause } from "effect"
 *
 * const error = new Cause.TimeoutError("Operation timed out")
 * console.log(error.message) // "Operation timed out"
 * ```
 *
 * @category constructors
 * @since 4.0.0
 */
export const TimeoutError: new(message?: string) => TimeoutError = effect.TimeoutError

/**
 * Unique brand for `IllegalArgumentError`.
 *
 * @category type IDs
 * @since 4.0.0
 */
export const IllegalArgumentErrorTypeId: "~effect/Cause/IllegalArgumentError" = effect.IllegalArgumentErrorTypeId

/**
 * Checks whether an arbitrary value is an `IllegalArgumentError`.
 *
 * **Example** (runtime type check)
 *
 * ```ts
 * import { Cause } from "effect"
 *
 * console.log(Cause.isIllegalArgumentError(new Cause.IllegalArgumentError())) // true
 * console.log(Cause.isIllegalArgumentError("nope")) // false
 * ```
 *
 * @category guards
 * @since 4.0.0
 */
export const isIllegalArgumentError: (u: unknown) => u is IllegalArgumentError = effect.isIllegalArgumentError

/**
 * An error indicating that a function received an argument that violates
 * its contract (e.g. negative where positive was expected).
 *
 * **Details**
 *
 * Implements `YieldableError`.
 *
 * **Example** (creating and checking)
 *
 * ```ts
 * import { Cause } from "effect"
 *
 * const error = new Cause.IllegalArgumentError("Expected positive number")
 * console.log(error._tag)    // "IllegalArgumentError"
 * console.log(error.message) // "Expected positive number"
 * ```
 *
 * @category errors
 * @since 4.0.0
 */
export interface IllegalArgumentError extends YieldableError {
  readonly [IllegalArgumentErrorTypeId]: typeof IllegalArgumentErrorTypeId
  readonly _tag: "IllegalArgumentError"
}

/**
 * Constructs an `IllegalArgumentError` with an optional message.
 *
 * **Example** (creating an IllegalArgumentError)
 *
 * ```ts
 * import { Cause } from "effect"
 *
 * const error = new Cause.IllegalArgumentError("Invalid argument")
 * console.log(error.message) // "Invalid argument"
 * ```
 *
 * @category constructors
 * @since 4.0.0
 */
export const IllegalArgumentError: new(message?: string) => IllegalArgumentError = effect.IllegalArgumentError

/**
 * Checks whether an arbitrary value is an `ExceededCapacityError`.
 *
 * **Example** (runtime type check)
 *
 * ```ts
 * import { Cause } from "effect"
 *
 * console.log(Cause.isExceededCapacityError(new Cause.ExceededCapacityError())) // true
 * console.log(Cause.isExceededCapacityError("nope")) // false
 * ```
 *
 * @category guards
 * @since 4.0.0
 */
export const isExceededCapacityError: (u: unknown) => u is ExceededCapacityError = effect.isExceededCapacityError

/**
 * Unique brand for `ExceededCapacityError`.
 *
 * @category type IDs
 * @since 4.0.0
 */
export const ExceededCapacityErrorTypeId: "~effect/Cause/ExceededCapacityError" = effect.ExceededCapacityErrorTypeId

/**
 * An error indicating that a bounded resource (queue, pool, semaphore, etc.)
 * has exceeded its capacity.
 *
 * **When to use**
 *
 * Use to model bounded-resource failures where an operation cannot proceed
 * because capacity has been exhausted.
 *
 * **Details**
 *
 * Implements `YieldableError`.
 *
 * **Example** (creating and checking)
 *
 * ```ts
 * import { Cause } from "effect"
 *
 * const error = new Cause.ExceededCapacityError("Queue full")
 * console.log(error._tag)    // "ExceededCapacityError"
 * console.log(error.message) // "Queue full"
 * ```
 *
 * @category errors
 * @since 4.0.0
 */
export interface ExceededCapacityError extends YieldableError {
  readonly [ExceededCapacityErrorTypeId]: typeof ExceededCapacityErrorTypeId
  readonly _tag: "ExceededCapacityError"
}

/**
 * Constructs an `ExceededCapacityError` with an optional message.
 *
 * **When to use**
 *
 * Use to create the error value for bounded-resource capacity failures.
 *
 * **Example** (creating an ExceededCapacityError)
 *
 * ```ts
 * import { Cause } from "effect"
 *
 * const error = new Cause.ExceededCapacityError("Queue full")
 * console.log(error.message) // "Queue full"
 * ```
 *
 * @see {@link isExceededCapacityError} for checking unknown values
 *
 * @category constructors
 * @since 4.0.0
 */
export const ExceededCapacityError: new(message?: string) => ExceededCapacityError = effect.ExceededCapacityError

/**
 * Unique brand present on `AsyncFiberError` values and used by
 * `isAsyncFiberError` for runtime checks.
 *
 * @category type IDs
 * @since 4.0.0
 */
export const AsyncFiberErrorTypeId: "~effect/Cause/AsyncFiberError" = effect.AsyncFiberErrorTypeId

/**
 * Checks whether an arbitrary value is an `AsyncFiberError`.
 *
 * **Example** (runtime type check)
 *
 * ```ts
 * import { Cause } from "effect"
 * import type { Fiber } from "effect"
 *
 * declare const fiber: Fiber.Fiber<unknown, unknown>
 *
 * const error = new Cause.AsyncFiberError(fiber)
 * console.log(Cause.isAsyncFiberError(error)) // true
 * console.log(Cause.isAsyncFiberError("nope")) // false
 * ```
 *
 * @category guards
 * @since 4.0.0
 */
export const isAsyncFiberError: (u: unknown) => u is AsyncFiberError = effect.isAsyncFiberError

/**
 * An error that occurs when trying to run an async fiber with Effect.runSync.
 *
 * **When to use**
 *
 * Use to inspect failures produced when synchronous runners encounter an effect
 * that cannot complete synchronously.
 *
 * **Details**
 *
 * The `fiber` property stores the fiber that could not be synchronously
 * resolved. This error implements `YieldableError`.
 *
 * **Example** (accessing the fiber)
 *
 * ```ts
 * import { Cause } from "effect"
 * import type { Fiber } from "effect"
 *
 * declare const fiber: Fiber.Fiber<unknown, unknown>
 *
 * const error = new Cause.AsyncFiberError(fiber)
 * console.log(error._tag) // "AsyncFiberError"
 * console.log(error.fiber === fiber) // true
 * ```
 *
 * @category errors
 * @since 4.0.0
 */
export interface AsyncFiberError extends YieldableError {
  readonly [AsyncFiberErrorTypeId]: typeof AsyncFiberErrorTypeId
  readonly _tag: "AsyncFiberError"
  readonly fiber: Fiber<unknown, unknown>
}

/**
 * Constructs an `AsyncFiberError` for a fiber that could not be resolved
 * synchronously.
 *
 * **When to use**
 *
 * Use to create the error value for a fiber that could not be completed by a
 * synchronous runner.
 *
 * **Example** (creating an AsyncFiberError)
 *
 * ```ts
 * import { Cause } from "effect"
 * import type { Fiber } from "effect"
 *
 * declare const fiber: Fiber.Fiber<unknown, unknown>
 *
 * const error = new Cause.AsyncFiberError(fiber)
 * console.log(error.message) // "An asynchronous Effect was executed with Effect.runSync"
 * ```
 *
 * @see {@link isAsyncFiberError} for checking unknown values
 *
 * @category constructors
 * @since 4.0.0
 */
export const AsyncFiberError: new(fiber: Fiber<unknown, unknown>) => AsyncFiberError = effect.AsyncFiberError

/**
 * Unique brand for `UnknownError`.
 *
 * @category type IDs
 * @since 4.0.0
 */
export const UnknownErrorTypeId: "~effect/Cause/UnknownError" = effect.UnknownErrorTypeId

/**
 * Checks whether an arbitrary value is an `UnknownError`.
 *
 * **Example** (runtime type check)
 *
 * ```ts
 * import { Cause } from "effect"
 *
 * console.log(Cause.isUnknownError(new Cause.UnknownError("x"))) // true
 * console.log(Cause.isUnknownError("nope")) // false
 * ```
 *
 * @category guards
 * @since 4.0.0
 */
export const isUnknownError: (u: unknown) => u is UnknownError = effect.isUnknownError

/**
 * A wrapper for errors whose type is not statically known.
 *
 * **Details**
 *
 * Used when a thrown or rejected value is not represented by a more specific
 * typed error. The original value is stored in the `cause` property inherited
 * from `Error`. Implements `YieldableError`.
 *
 * **Example** (creating and checking)
 *
 * ```ts
 * import { Cause } from "effect"
 *
 * const error = new Cause.UnknownError("original", "Something unknown")
 * console.log(error._tag)    // "UnknownError"
 * console.log(error.message) // "Something unknown"
 * ```
 *
 * @category errors
 * @since 4.0.0
 */
export interface UnknownError extends YieldableError {
  readonly [UnknownErrorTypeId]: typeof UnknownErrorTypeId
  readonly _tag: "UnknownError"
}

/**
 * Constructs an `UnknownError`. The first argument is the original
 * cause (stored in `Error.cause`); the second is an optional human-readable
 * message.
 *
 * **Example** (creating an UnknownError)
 *
 * ```ts
 * import { Cause } from "effect"
 *
 * const error = new Cause.UnknownError({ raw: true }, "Unexpected value")
 * console.log(error.message) // "Unexpected value"
 * ```
 *
 * @category constructors
 * @since 4.0.0
 */
export const UnknownError: new(cause: unknown, message?: string) => UnknownError = effect.UnknownError

/**
 * Attaches metadata to every reason in a `Cause`.
 *
 * **When to use**
 *
 * Use to attach diagnostic metadata to every reason in a cause.
 *
 * **Details**
 *
 * Annotations are stored as a `Context` on each reason and can be
 * retrieved later via {@link reasonAnnotations} or {@link annotations}.
 * The runtime uses this to attach stack traces and spans.
 *
 * - Returns a new `Cause`.
 * - By default, existing keys are preserved. Pass `{ overwrite: true }` to
 *   replace them.
 *
 * **Example** (annotating a cause)
 *
 * ```ts
 * import { Cause, Context } from "effect"
 *
 * class RequestId extends Context.Service<RequestId, string>()("RequestId") {}
 *
 * const cause = Cause.fail("error")
 * const annotated = Cause.annotate(cause, Context.make(RequestId, "req-1"))
 *
 * console.log(Context.getOrUndefined(Cause.annotations(annotated), RequestId)) // "req-1"
 * ```
 *
 * @see {@link annotations} for reading merged annotations from a cause
 * @see {@link reasonAnnotations} for reading annotations from a single reason
 *
 * @category annotations
 * @since 4.0.0
 */
export const annotate: {
  (
    annotations: Context.Context<never>,
    options?: { readonly overwrite?: boolean | undefined }
  ): <E>(self: Cause<E>) => Cause<E>
  <E>(
    self: Cause<E>,
    annotations: Context.Context<never>,
    options?: { readonly overwrite?: boolean | undefined }
  ): Cause<E>
} = core.causeAnnotate

/**
 * Reads the annotations from a single `Reason` as a `Context`.
 *
 * **When to use**
 *
 * Use when you need tracing metadata (e.g. `StackTrace`) from
 * a specific reason rather than the whole cause.
 *
 * **Example** (reading reason annotations)
 *
 * ```ts
 * import { Cause, Context } from "effect"
 *
 * class RequestId extends Context.Service<RequestId, string>()("RequestId") {}
 *
 * const reason = Cause.makeFailReason("error")
 * const annotated = reason.annotate(Context.make(RequestId, "req-1"))
 *
 * console.log(Context.getOrUndefined(Cause.reasonAnnotations(annotated), RequestId)) // "req-1"
 * ```
 *
 * @see {@link annotations} — merged annotations from all reasons in a cause
 *
 * @category annotations
 * @since 4.0.0
 */
export const reasonAnnotations: <E>(self: Reason<E>) => Context.Context<never> = effect.reasonAnnotations

/**
 * Reads the merged annotations from all reasons in a `Cause`.
 *
 * **When to use**
 *
 * Use to read diagnostic metadata merged from the whole cause.
 *
 * **Gotchas**
 *
 * When multiple reasons contain the same annotation key, the value from the
 * later reason wins.
 *
 * **Example** (reading merged annotations)
 *
 * ```ts
 * import { Cause, Context } from "effect"
 *
 * class RequestId extends Context.Service<RequestId, string>()("RequestId") {}
 *
 * const cause = Cause.annotate(
 *   Cause.fail("error"),
 *   Context.make(RequestId, "req-1")
 * )
 *
 * console.log(Context.getOrUndefined(Cause.annotations(cause), RequestId)) // "req-1"
 * ```
 *
 * @see {@link reasonAnnotations} — annotations from a single reason
 *
 * @category annotations
 * @since 4.0.0
 */
export const annotations: <E>(self: Cause<E>) => Context.Context<never> = effect.causeAnnotations

/**
 * Context annotation used to store the stack frame captured at the point of failure.
 *
 * **When to use**
 *
 * Use to read the failure stack-frame annotation from a `Reason` when building
 * diagnostics, logging, or custom cause renderers.
 *
 * **Details**
 *
 * The runtime annotates every reason with this when a stack frame is
 * available. Retrieve it via
 * `Context.get(Cause.reasonAnnotations(reason), Cause.StackTrace)`.
 *
 * @see {@link reasonAnnotations} for reading annotations from a single reason
 * @see {@link annotations} for reading merged annotations from a cause
 * @see {@link InterruptorStackTrace} for the interrupt-specific stack-frame annotation
 *
 * @category annotations
 * @since 4.0.0
 */
export class StackTrace extends Context.Service<StackTrace, StackFrame>()("effect/Cause/StackTrace") {}

/**
 * Context annotation used to store the stack frame captured at the point of
 * interruption.
 *
 * **When to use**
 *
 * Use when attaching or reading the stack-frame annotation consumed by
 * interrupt-only cause rendering.
 *
 * **Details**
 *
 * Similar to `StackTrace` but specific to `Interrupt` reasons.
 *
 * @see {@link StackTrace} for stack frames attached to failures
 * @see {@link reasonAnnotations} for reading annotations from a single reason
 * @see {@link annotate} for attaching annotations to a cause
 *
 * @category annotations
 * @since 4.0.0
 */
export class InterruptorStackTrace
  extends Context.Service<InterruptorStackTrace, StackFrame>()("effect/Cause/InterruptorStackTrace")
{}

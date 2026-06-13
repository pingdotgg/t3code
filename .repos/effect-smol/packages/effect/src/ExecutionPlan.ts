/**
 * Defines finite fallback plans for effects and streams that should retry the
 * same work with different services. An `ExecutionPlan` is a non-empty
 * sequence of steps. Each step provides a `Context` or `Layer`, and can limit
 * or shape retries with `attempts`, `schedule`, and `while`.
 *
 * Use a plan with `Effect.withExecutionPlan` or `Stream.withExecutionPlan`.
 * Those APIs run the wrapped work with the first step, retry within that step
 * as directed, then move to later steps until the work succeeds or the plan is
 * exhausted.
 *
 * **Mental model**
 *
 * - A step is a resource profile for one part of a fallback strategy
 * - The active step supplies the services visible to the wrapped effect or
 *   stream
 * - `attempts` caps the number of tries for a step
 * - `schedule` controls retry timing and receives the wrapped work's failure
 *   value
 * - `while` can stop the current step early by inspecting the same failure
 *   value
 * - `CurrentMetadata` exposes the 1-based attempt number and 0-based step
 *   index to code running under the active step
 *
 * **Common tasks**
 *
 * - Build a plan with {@link make}
 * - Append fallback plans with {@link merge}
 * - Apply a plan with `Effect.withExecutionPlan` or `Stream.withExecutionPlan`
 * - Read active step and attempt information with {@link CurrentMetadata}
 * - Carry the current environment into a plan with `captureRequirements`
 *
 * **Quickstart**
 *
 * **Example** (Retry with one layer, then fall back)
 *
 * ```ts
 * import { Context, Effect, ExecutionPlan, Layer, Schedule } from "effect"
 *
 * class Endpoint extends Context.Service<Endpoint>()("Endpoint", {
 *   make: Effect.succeed({ url: "primary" })
 * }) {}
 *
 * const primary = Layer.succeed(Endpoint, Endpoint.of({ url: "primary" }))
 * const fallback = Layer.succeed(Endpoint, Endpoint.of({ url: "fallback" }))
 *
 * const plan = ExecutionPlan.make(
 *   {
 *     provide: primary,
 *     attempts: 2,
 *     schedule: Schedule.recurs(1)
 *   },
 *   {
 *     provide: fallback
 *   }
 * )
 *
 * const program = Effect.gen(function*() {
 *   const endpoint = yield* Endpoint
 *   if (endpoint.url === "primary") {
 *     return yield* Effect.fail("unavailable")
 *   }
 *   return endpoint.url
 * }).pipe(Effect.withExecutionPlan(plan))
 * ```
 *
 * **Gotchas**
 *
 * - Plans must contain at least one step
 * - `attempts` must be greater than zero when provided
 * - Without `attempts` or `schedule`, a step is tried once
 * - A `schedule` can keep a step active until bounded by `attempts` or
 *   stopped by `while`
 * - Layer, schedule, and predicate requirements stay in the plan type until
 *   they are provided or captured
 *
 * **See also**
 *
 * - {@link make} for constructing plans
 * - {@link merge} for combining plans in order
 * - {@link CurrentMetadata} for inspecting the active attempt
 *
 * @since 3.16.0
 */
import type { NonEmptyReadonlyArray } from "./Array.ts"
import * as Context from "./Context.ts"
import type * as Effect from "./Effect.ts"
import { constant } from "./Function.ts"
import * as effect from "./internal/effect.ts"
import * as Layer from "./Layer.ts"
import type { Pipeable } from "./Pipeable.ts"
import { pipeArguments } from "./Pipeable.ts"
import * as Predicate from "./Predicate.ts"
import type * as Schedule from "./Schedule.ts"

/**
 * String literal type used as the runtime type identifier for `ExecutionPlan`
 * values.
 *
 * @category type IDs
 * @since 3.16.0
 */
export type TypeId = "~effect/ExecutionPlan"

/**
 * Runtime type identifier attached to `ExecutionPlan` values and used by
 * `isExecutionPlan`.
 *
 * @category type IDs
 * @since 3.16.0
 */
export const TypeId: TypeId = "~effect/ExecutionPlan"

/**
 * Returns `true` if a value is an `ExecutionPlan` by checking for the
 * `ExecutionPlan.TypeId` marker.
 *
 * **When to use**
 *
 * Use when accepting an unknown value and you need to narrow it to an
 * `ExecutionPlan` before reading plan fields or passing it to plan-consuming
 * APIs.
 *
 * **Gotchas**
 *
 * This is a structural marker check; it does not validate the marker value or
 * the shape of the plan steps.
 *
 * @see {@link make} for constructing execution plans that satisfy this guard
 * @see {@link TypeId} for the runtime marker checked by this guard
 *
 * @category guards
 * @since 3.16.0
 */
export const isExecutionPlan = (u: unknown): u is ExecutionPlan<any> => Predicate.hasProperty(u, TypeId)

/**
 * A `ExecutionPlan` can be used with `Effect.withExecutionPlan` or `Stream.withExecutionPlan`, allowing you to provide different resources for each step of execution until the effect succeeds or the plan is exhausted.
 *
 * **Example** (Defining fallback execution steps)
 *
 * ```ts
 * import { Effect, ExecutionPlan, Schedule } from "effect"
 * import type { Layer } from "effect"
 * import type { LanguageModel } from "effect/unstable/ai"
 *
 * declare const layerBad: Layer.Layer<LanguageModel.LanguageModel>
 * declare const layerGood: Layer.Layer<LanguageModel.LanguageModel>
 *
 * const ThePlan = ExecutionPlan.make(
 *   {
 *     // First try with the bad layer 2 times with a 3 second delay between attempts
 *     provide: layerBad,
 *     attempts: 2,
 *     schedule: Schedule.spaced(3000)
 *   },
 *   // Then try with the bad layer 3 times with a 1 second delay between attempts
 *   {
 *     provide: layerBad,
 *     attempts: 3,
 *     schedule: Schedule.spaced(1000)
 *   },
 *   // Finally try with the good layer.
 *   //
 *   // If `attempts` is omitted, the plan will only attempt once, unless a schedule is provided.
 *   {
 *     provide: layerGood
 *   }
 * )
 *
 * declare const effect: Effect.Effect<
 *   void,
 *   never,
 *   LanguageModel.LanguageModel
 * >
 * const withPlan: Effect.Effect<void> = Effect.withExecutionPlan(effect, ThePlan)
 * ```
 *
 * @category models
 * @since 3.16.0
 */
export interface ExecutionPlan<
  Config extends {
    provides: any
    input: any
    error: any
    requirements: any
  }
> extends Pipeable {
  readonly [TypeId]: TypeId
  readonly steps: NonEmptyReadonlyArray<{
    readonly provide:
      | Context.Context<Config["provides"]>
      | Layer.Layer<Config["provides"], Config["error"], Config["requirements"]>
    readonly attempts?: number | undefined
    readonly while?:
      | ((input: Config["input"]) => Effect.Effect<boolean, Config["error"], Config["requirements"]>)
      | undefined
    readonly schedule?: Schedule.Schedule<any, Config["input"], Config["requirements"]> | undefined
  }>

  /**
   * Returns an equivalent `ExecutionPlan` with the requirements satisfied, using the current context.
   */
  readonly captureRequirements: Effect.Effect<
    ExecutionPlan<{
      provides: Config["provides"]
      input: Config["input"]
      error: Config["error"]
      requirements: never
    }>,
    never,
    Config["requirements"]
  >
}

/**
 * Base type-level configuration carried by an `ExecutionPlan`.
 *
 * **Details**
 *
 * `provides` tracks services supplied by plan steps, `input` tracks the error
 * input consumed by schedules and `while` predicates, `error` tracks failures
 * from plan layers or predicates, and `requirements` tracks services needed to
 * build or run the plan.
 *
 * @category models
 * @since 4.0.0
 */
export type ConfigBase = {
  provides: any
  input: any
  error: any
  requirements: any
}

/**
 * Create an `ExecutionPlan`, which can be used with `Effect.withExecutionPlan` or `Stream.withExecutionPlan`, allowing you to provide different resources for each step of execution until the effect succeeds or the plan is exhausted.
 *
 * **Example** (Creating an execution plan)
 *
 * ```ts
 * import { Effect, ExecutionPlan, Schedule } from "effect"
 * import type { Layer } from "effect"
 * import type { LanguageModel } from "effect/unstable/ai"
 *
 * declare const layerBad: Layer.Layer<LanguageModel.LanguageModel>
 * declare const layerGood: Layer.Layer<LanguageModel.LanguageModel>
 *
 * const ThePlan = ExecutionPlan.make(
 *   {
 *     // First try with the bad layer 2 times with a 3 second delay between attempts
 *     provide: layerBad,
 *     attempts: 2,
 *     schedule: Schedule.spaced(3000)
 *   },
 *   // Then try with the bad layer 3 times with a 1 second delay between attempts
 *   {
 *     provide: layerBad,
 *     attempts: 3,
 *     schedule: Schedule.spaced(1000)
 *   },
 *   // Finally try with the good layer.
 *   //
 *   // If `attempts` is omitted, the plan will only attempt once, unless a schedule is provided.
 *   {
 *     provide: layerGood
 *   }
 * )
 *
 * declare const effect: Effect.Effect<
 *   void,
 *   never,
 *   LanguageModel.LanguageModel
 * >
 * const withPlan: Effect.Effect<void> = Effect.withExecutionPlan(effect, ThePlan)
 * ```
 *
 * @category constructors
 * @since 3.16.0
 */
export const make = <const Steps extends NonEmptyReadonlyArray<make.Step>>(
  ...steps: Steps & { [K in keyof Steps]: make.Step }
): ExecutionPlan<{
  provides: make.StepProvides<Steps>
  input: make.StepInput<Steps>
  error:
    | (Steps[number]["provide"] extends Context.Context<infer _P> | Layer.Layer<infer _P, infer E, infer _R> ? E
      : never)
    | (Steps[number]["while"] extends (input: infer _I) => Effect.Effect<infer _A, infer _E, infer _R> ? _E : never)
  requirements:
    | (Steps[number]["provide"] extends Layer.Layer<infer _A, infer _E, infer R> ? R : never)
    | (Steps[number]["while"] extends (input: infer _I) => Effect.Effect<infer _A, infer _E, infer R> ? R : never)
    | (Steps[number]["schedule"] extends Schedule.Schedule<infer _O, infer _I, infer R> ? R : never)
}> =>
  makeProto(steps.map((options, i) => {
    if (options.attempts && options.attempts < 1) {
      throw new Error(`ExecutionPlan.make: step[${i}].attempts must be greater than 0`)
    }
    return {
      schedule: options.schedule,
      attempts: options.attempts,
      while: options.while
        ? (input: any) =>
          effect.suspend(() => {
            const result = options.while!(input)
            return typeof result === "boolean" ? effect.succeed(result) : result
          })
        : undefined,
      provide: options.provide
    }
  }) as any)

/**
 * Namespace containing type helpers used by `ExecutionPlan.make`.
 *
 * @since 3.16.0
 */
export declare namespace make {
  /**
   * Input shape for a single execution-plan step.
   *
   * **Details**
   *
   * Each step provides a `Context` or `Layer` and may limit attempts, add a
   * `while` predicate for retry decisions, or attach a `Schedule` for retry
   * timing.
   *
   * @category models
   * @since 3.16.0
   */
  export type Step = {
    readonly provide: Context.Context<any> | Context.Context<never> | Layer.Any
    readonly attempts?: number | undefined
    readonly while?: ((input: any) => boolean | Effect.Effect<boolean, any, any>) | undefined
    readonly schedule?: Schedule.Schedule<any, any, any> | undefined
  }

  /**
   * Computes the intersection of services provided by a list of execution-plan
   * steps.
   *
   * @category utility types
   * @since 3.16.1
   */
  export type StepProvides<Steps extends ReadonlyArray<any>, Out = unknown> = Steps extends
    readonly [infer Step, ...infer Rest] ? StepProvides<
      Rest,
      & Out
      & (
        (Step extends { readonly provide: Context.Context<infer P> | Layer.Layer<infer P, infer _E, infer _R> } ? P
          : unknown)
      )
    > :
    Out

  /**
   * Computes the intersection of services provided by a list of execution plans.
   *
   * @category utility types
   * @since 3.16.1
   */
  export type PlanProvides<Plans extends ReadonlyArray<any>, Out = unknown> = Plans extends
    readonly [infer Plan, ...infer Rest] ?
    PlanProvides<Rest, Out & (Plan extends ExecutionPlan<infer T> ? T["provides"] : unknown)> :
    Out

  /**
   * Computes the input type consumed by the `while` predicates and schedules in
   * a list of execution-plan steps.
   *
   * @category utility types
   * @since 3.16.0
   */
  export type StepInput<Steps extends ReadonlyArray<any>, Out = unknown> = Steps extends
    readonly [infer Step, ...infer Rest] ? StepInput<
      Rest,
      & Out
      & (
        & (Step extends { readonly while: (input: infer I) => infer _ } ? I : unknown)
        & (Step extends { readonly schedule: Schedule.Schedule<infer _O, infer I, infer _R> } ? I : unknown)
      )
    > :
    Out

  /**
   * Computes the combined input type consumed by a list of execution plans.
   *
   * @category utility types
   * @since 3.16.0
   */
  export type PlanInput<Plans extends ReadonlyArray<any>, Out = unknown> = Plans extends
    readonly [infer Plan, ...infer Rest] ?
    PlanInput<Rest, Out & (Plan extends ExecutionPlan<infer T> ? T["input"] : unknown)> :
    Out
}

const Proto: Omit<ExecutionPlan<any>, "steps"> = {
  [TypeId]: TypeId,
  get captureRequirements() {
    const self = this as any as ExecutionPlan<any>
    return effect.contextWith((context: Context.Context<any>) =>
      effect.succeed(makeProto(self.steps.map((step) => ({
        ...step,
        provide: Layer.isLayer(step.provide)
          ? Layer.provide(step.provide, Layer.succeedContext(context))
          : step.provide
      })) as any))
    )
  },
  pipe() {
    return pipeArguments(this, arguments)
  }
}

const makeProto = <Provides, In, PlanE, PlanR>(
  steps: ExecutionPlan<{
    provides: Provides
    input: In
    error: PlanE
    requirements: PlanR
  }>["steps"]
) => {
  const self = Object.create(Proto)
  self.steps = steps
  return self
}

/**
 * Combines multiple execution plans by concatenating their steps in order.
 *
 * **When to use**
 *
 * Use to combine separately defined fallback plans into one ordered plan before
 * applying it to an effect or stream.
 *
 * **Details**
 *
 * The resulting plan tries every step from the first plan, then every step from
 * the next plan, and so on.
 *
 * @see {@link make} for building a plan from individual steps instead of combining existing plans
 *
 * @category Combining
 * @since 3.16.0
 */
export const merge = <const Plans extends NonEmptyReadonlyArray<ExecutionPlan<any>>>(
  ...plans: Plans
): ExecutionPlan<{
  provides: make.PlanProvides<Plans>
  input: make.PlanInput<Plans>
  error: Plans[number] extends ExecutionPlan<infer T> ? T["error"] : never
  requirements: Plans[number] extends ExecutionPlan<infer T> ? T["requirements"] : never
}> => makeProto(plans.flatMap((plan) => plan.steps) as any)

/**
 * Metadata describing the currently running execution-plan attempt.
 *
 * **Details**
 *
 * `attempt` is the current 1-based attempt number, and `stepIndex` is the
 * 0-based index of the plan step currently being evaluated.
 *
 * @category Metadata
 * @since 4.0.0
 */
export interface Metadata {
  readonly attempt: number
  readonly stepIndex: number
}

/**
 * Context reference containing metadata for the currently running
 * execution-plan attempt.
 *
 * **When to use**
 *
 * Use to read the active plan step and attempt while code is running under an
 * execution plan.
 *
 * @category metadata
 * @since 4.0.0
 */
export const CurrentMetadata = Context.Reference<Metadata>("effect/ExecutionPlan/CurrentMetadata", {
  defaultValue: constant({
    attempt: 0,
    stepIndex: 0
  })
})

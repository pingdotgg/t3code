/**
 * The `Workflow` module defines typed durable workflow descriptions and the
 * helpers used to execute them through a `WorkflowEngine`. A workflow combines
 * a stable name, a struct payload schema, success and error schemas, and an
 * idempotency key so callers can derive deterministic execution IDs, execute or
 * discard runs, poll results, interrupt or resume suspended executions, and
 * register handlers with `toLayer`.
 *
 * Workflows are intended for long-running business processes that coordinate
 * activities, durable deferreds, durable clocks, retries, and compensation.
 * Keep external side effects at activity boundaries so engine implementations
 * can safely persist, suspend, and resume execution state. Running activities
 * can delay workflow suspension until they finish or suspend, and compensation
 * registered with `withCompensation` only applies to top-level workflow
 * effects, not nested activities.
 *
 * When exposing workflows through `WorkflowProxy`, remember that proxy APIs are
 * derived from the workflow name and schemas. Discard execution returns the
 * `executionId` instead of the workflow result, resume requires the persisted
 * `executionId`, and idempotency keys must remain stable for the same logical
 * request.
 *
 * @since 4.0.0
 */
import * as Arr from "../../Array.ts"
import * as Cause from "../../Cause.ts"
import * as Context from "../../Context.ts"
import * as Data from "../../Data.ts"
import * as Effect from "../../Effect.ts"
import * as Exit from "../../Exit.ts"
import * as Fiber from "../../Fiber.ts"
import * as Filter from "../../Filter.ts"
import { constFalse, constTrue, dual, identity } from "../../Function.ts"
import * as Layer from "../../Layer.ts"
import * as Option from "../../Option.ts"
import * as Predicate from "../../Predicate.ts"
import type * as Schedule from "../../Schedule.ts"
import * as Schema from "../../Schema.ts"
import * as Issue from "../../SchemaIssue.ts"
import * as Parser from "../../SchemaParser.ts"
import * as Tranformation from "../../SchemaTransformation.ts"
import * as Scope from "../../Scope.ts"
import type { ExitEncoded } from "../rpc/RpcMessage.ts"
import { makeHashDigest } from "./internal/crypto.ts"
import type { WorkflowEngine, WorkflowInstance } from "./WorkflowEngine.ts"

const TypeId = "~effect/workflow/Workflow"

/**
 * Durable workflow definition with typed payload, success, and error schemas
 * plus operations for execution, polling, interruption, resumption, and
 * registration.
 *
 * @category models
 * @since 4.0.0
 */
export interface Workflow<
  Name extends string,
  Payload extends AnyStructSchema,
  Success extends Schema.Top,
  Error extends Schema.Top
> {
  readonly [TypeId]: typeof TypeId
  readonly name: Name
  readonly payloadSchema: Payload
  readonly successSchema: Success
  readonly errorSchema: Error
  readonly annotations: Context.Context<never>

  /**
   * Add an annotation to the workflow.
   */
  annotate<I, S>(
    key: Context.Key<I, S>,
    value: S
  ): Workflow<Name, Payload, Success, Error>

  /**
   * Merge multiple annotations into the workflow.
   */
  annotateMerge<I>(
    annotations: Context.Context<I>
  ): Workflow<Name, Payload, Success, Error>

  /**
   * Execute the workflow with the given payload.
   */
  readonly execute: <const Discard extends boolean = false>(
    payload: Payload["~type.make.in"],
    options?: {
      readonly discard?: Discard
    }
  ) => Effect.Effect<
    Discard extends true ? string : Success["Type"],
    Discard extends true ? never : Error["Type"],
    | WorkflowEngine
    | Payload["EncodingServices"]
    | Success["DecodingServices"]
    | Error["DecodingServices"]
  >

  /**
   * Execute the workflow with the given payload.
   */
  readonly poll: (
    executionId: string
  ) => Effect.Effect<
    Option.Option<Result<Success["Type"], Error["Type"]>>,
    never,
    WorkflowEngine | Success["DecodingServices"] | Error["DecodingServices"]
  >

  /**
   * Interrupt a workflow execution for the given execution ID.
   */
  readonly interrupt: (
    executionId: string
  ) => Effect.Effect<void, never, WorkflowEngine>

  /**
   * Manually resume a workflow execution for the given execution ID.
   */
  readonly resume: (
    executionId: string
  ) => Effect.Effect<void, never, WorkflowEngine>

  /**
   * Create a layer that registers the workflow and provides an effect to
   * execute it.
   */
  readonly toLayer: <R>(
    execute: (
      payload: Payload["Type"],
      executionId: string
    ) => Effect.Effect<Success["Type"], Error["Type"], R>
  ) => Layer.Layer<
    never,
    never,
    | WorkflowEngine
    | Exclude<
      R,
      WorkflowEngine | WorkflowInstance | Execution<Name> | Scope.Scope
    >
    | Payload["DecodingServices"]
    | Payload["EncodingServices"]
    | Success["DecodingServices"]
    | Success["EncodingServices"]
    | Error["DecodingServices"]
    | Error["EncodingServices"]
  >

  /**
   * For the given payload, compute the deterministic execution ID.
   */
  readonly executionId: (
    payload: Payload["~type.make.in"]
  ) => Effect.Effect<string>

  /**
   * Add compensation logic to an effect inside a Workflow.
   *
   * **Details**
   *
   * The compensation finalizer is called if the entire workflow fails, allowing you to perform cleanup or other actions based on the success value and the cause of the workflow failure.
   *
   * **Gotchas**
   *
   * Compensation finalizers are only registered for top-level effects in the workflow and do not work for nested activities.
   */
  readonly withCompensation: {
    <A, R2>(
      compensation: (
        value: A,
        cause: Cause.Cause<Error["Type"]>
      ) => Effect.Effect<void, never, R2>
    ): <E, R>(
      effect: Effect.Effect<A, E, R>
    ) => Effect.Effect<
      A,
      E,
      R | R2 | WorkflowInstance | Execution<Name> | Scope.Scope
    >
    <A, E, R, R2>(
      effect: Effect.Effect<A, E, R>,
      compensation: (
        value: A,
        cause: Cause.Cause<Error["Type"]>
      ) => Effect.Effect<void, never, R2>
    ): Effect.Effect<
      A,
      E,
      R | R2 | WorkflowInstance | Execution<Name> | Scope.Scope
    >
  }
}

/**
 * Schema constraint for workflow payload schemas that expose struct fields.
 *
 * @category schemas
 * @since 4.0.0
 */
export interface AnyStructSchema extends Schema.Top {
  readonly fields: Schema.Struct.Fields
}

/**
 * Type-level marker for services associated with a specific workflow
 * execution name.
 *
 * @category models
 * @since 4.0.0
 */
export interface Execution<Name extends string> {
  readonly _: unique symbol
  readonly name: Name
}

/**
 * Type-erased workflow shape for APIs that operate on workflows without
 * preserving their specific payload, success, or error types.
 *
 * @category models
 * @since 4.0.0
 */
export interface Any {
  readonly [TypeId]: typeof TypeId
  readonly name: string
  readonly executionId: (payload: any) => Effect.Effect<string>
  readonly payloadSchema: AnyStructSchema
  readonly successSchema: Schema.Top
  readonly errorSchema: Schema.Top
  readonly annotations: Context.Context<never>
}

/**
 * Type-erased workflow shape that also exposes executable operations needed by
 * workflow proxy and engine helpers.
 *
 * @category models
 * @since 4.0.0
 */
export interface AnyWithProps extends Any {
  readonly payloadSchema: AnyStructSchema
  readonly successSchema: Schema.Top
  readonly errorSchema: Schema.Top
  readonly execute: (
    payload: any,
    options?: { readonly discard?: boolean }
  ) => Effect.Effect<any, any, any>
  readonly resume: (
    executionId: string
  ) => Effect.Effect<void, never, WorkflowEngine>
}

/**
 * Extracts the payload schema from a `Workflow`.
 *
 * @category models
 * @since 4.0.0
 */
export type PayloadSchema<W> = W extends Workflow<
  infer _Name,
  infer _Payload,
  infer _Success,
  infer _Error
> ? _Payload
  : never

/**
 * Computes the schema services required by clients that execute or poll
 * workflows.
 *
 * @category models
 * @since 4.0.0
 */
export type RequirementsClient<Workflows extends Any> = Workflows extends Workflow<
  infer _Name,
  infer _Payload,
  infer _Success,
  infer _Error
> ?
    | _Payload["EncodingServices"]
    | _Success["DecodingServices"]
    | _Error["DecodingServices"]
  : never

/**
 * Computes the schema services required by handlers that decode workflow
 * payloads and encode workflow results.
 *
 * @category models
 * @since 4.0.0
 */
export type RequirementsHandler<Workflows extends Any> = Workflows extends Workflow<
  infer _Name,
  infer _Payload,
  infer _Success,
  infer _Error
> ?
    | _Payload["DecodingServices"]
    | _Payload["EncodingServices"]
    | _Success["DecodingServices"]
    | _Success["EncodingServices"]
    | _Error["DecodingServices"]
    | _Error["EncodingServices"]
  : never

const EngineTag = Context.Service<WorkflowEngine, WorkflowEngine["Service"]>(
  "effect/workflow/WorkflowEngine" satisfies typeof WorkflowEngine.key
)

const InstanceTag = Context.Service<
  WorkflowInstance,
  WorkflowInstance["Service"]
>(
  "effect/workflow/WorkflowEngine/WorkflowInstance" satisfies typeof WorkflowInstance.key
)

/**
 * Creates a durable workflow definition with schemas, annotations, and
 * deterministic execution IDs derived from the workflow name and idempotency
 * key.
 *
 * @category constructors
 * @since 4.0.0
 */
export const make = <
  const Name extends string,
  Payload extends Schema.Struct.Fields | AnyStructSchema,
  Success extends Schema.Top = Schema.Void,
  Error extends Schema.Top = Schema.Never
>(options: {
  readonly name: Name
  readonly payload: Payload
  readonly idempotencyKey: (
    payload: Payload extends Schema.Struct.Fields ? Schema.Struct.Type<Payload>
      : Payload["Type"]
  ) => string
  readonly success?: Success
  readonly error?: Error
  readonly suspendedRetrySchedule?: Schedule.Schedule<any, unknown> | undefined
  readonly annotations?: Context.Context<never>
}): Workflow<
  Name,
  Payload extends Schema.Struct.Fields ? Schema.Struct<Payload> : Payload,
  Success,
  Error
> => {
  const makeExecutionId = (payload: any) => makeHashDigest(`${options.name}-${options.idempotencyKey(payload)}`)
  const self: Workflow<Name, any, Success, Error> = {
    [TypeId]: TypeId,
    name: options.name,
    payloadSchema: Schema.isSchema(options.payload)
      ? options.payload
      : Schema.Struct(options.payload as any),
    successSchema: options.success ?? (Schema.Void as any),
    errorSchema: options.error ?? (Schema.Never as any),
    annotations: options.annotations ?? Context.empty(),
    annotate(tag, value) {
      return make({
        ...options,
        annotations: Context.add(self.annotations, tag, value)
      })
    },
    annotateMerge(context) {
      return make({
        ...options,
        annotations: Context.merge(self.annotations, context)
      })
    },
    execute: Effect.fnUntraced(
      function*<const Discard extends boolean = false>(
        fields: any,
        opts?: { readonly discard?: Discard } | undefined
      ) {
        const payload = self.payloadSchema.make(fields)
        const engine = yield* EngineTag
        const executionId = yield* makeExecutionId(payload)
        yield* Effect.annotateCurrentSpan({ executionId })
        return yield* engine.execute(self, {
          executionId,
          payload,
          discard: opts?.discard,
          suspendedRetrySchedule: options.suspendedRetrySchedule
        })
      },
      Effect.withSpan(
        `${options.name}.execute`,
        {},
        { captureStackTrace: false }
      )
    ) as any,
    poll: Effect.fnUntraced(
      function*(executionId: string) {
        const engine = yield* EngineTag
        return yield* engine.poll(self, executionId)
      },
      (effect, executionId) =>
        Effect.withSpan(effect, `${options.name}.poll`, {
          captureStackTrace: false,
          attributes: { executionId }
        })
    ),
    interrupt: Effect.fnUntraced(
      function*(executionId: string) {
        const engine = yield* EngineTag
        yield* engine.interrupt(self, executionId)
      },
      (effect, executionId) =>
        Effect.withSpan(effect, `${options.name}.interrupt`, {
          captureStackTrace: false,
          attributes: { executionId }
        })
    ),
    resume: Effect.fnUntraced(
      function*(executionId: string) {
        const engine = yield* EngineTag
        yield* engine.resume(self, executionId)
      },
      (effect, executionId) =>
        Effect.withSpan(effect, `${options.name}.resume`, {
          captureStackTrace: false,
          attributes: { executionId }
        })
    ),
    toLayer: (execute) =>
      Layer.effectDiscard(
        Effect.gen(function*() {
          const engine = yield* EngineTag
          return yield* engine.register(self, execute)
        })
      ),
    executionId: (payload) =>
      Effect.flatMap(
        Effect.orDie(self.payloadSchema.makeEffect(payload)),
        makeExecutionId
      ),
    withCompensation
  }

  return self
}

const ResultTypeId = "~effect/workflow/Workflow/Result"

/**
 * Returns `true` when a value is a workflow `Result`.
 *
 * @category results
 * @since 4.0.0
 */
export const isResult = <A = unknown, E = unknown>(
  u: unknown
): u is Result<A, E> => Predicate.hasProperty(u, ResultTypeId)

/**
 * Result of a workflow execution, either a completed exit or a suspended
 * workflow state.
 *
 * @category results
 * @since 4.0.0
 */
export type Result<A, E> = Complete<A, E> | Suspended

/**
 * Encoded representation of a workflow `Result`.
 *
 * @category results
 * @since 4.0.0
 */
export type ResultEncoded<A, E> =
  | CompleteEncoded<A, E>
  | typeof Suspended.Encoded

/**
 * Encoded representation of a completed workflow result containing an encoded
 * `Exit`.
 *
 * @category results
 * @since 4.0.0
 */
export interface CompleteEncoded<A, E> {
  readonly _tag: "Complete"
  readonly exit: ExitEncoded<A, E>
}

/**
 * Schema constructor for `Complete` workflow results using the supplied
 * success and error schemas.
 *
 * @category schemas
 * @since 4.0.0
 */
export interface CompleteSchema<
  Success extends Schema.Top,
  Error extends Schema.Top
> extends
  Schema.declareConstructor<
    Complete<Success["Type"], Error["Type"]>,
    Complete<Success["Encoded"], Error["Encoded"]>,
    readonly [Schema.Exit<Success, Error, Schema.Defect>]
  >
{
  readonly success: Success
  readonly error: Error
}

/**
 * Represents a completed workflow execution with its success or failure `Exit`.
 *
 * @category results
 * @since 4.0.0
 */
export class Complete<A, E> extends Data.TaggedClass("Complete")<{
  readonly exit: Exit.Exit<A, E>
}> {
  /**
   * Marks this value as a workflow result for runtime guards.
   *
   * @since 4.0.0
   */
  readonly [ResultTypeId] = ResultTypeId

  /**
   * Builds the schema for completed workflow results from success and error schemas.
   *
   * @since 4.0.0
   */
  static Schema<Success extends Schema.Top, Error extends Schema.Top>(options: {
    readonly success: Success
    readonly error: Error
  }): CompleteSchema<Success, Error> {
    // TODO: extract to a helper function
    const schema = Schema.declareConstructor<
      Complete<Success["Type"], Error["Type"]>,
      Complete<Success["Encoded"], Error["Encoded"]>
    >()(
      [Schema.Exit(options.success, options.error, Schema.Defect)],
      ([exit]) => (input, ast, options) => {
        if (!(isResult(input) && input._tag === "Complete")) {
          return Effect.fail(new Issue.InvalidType(ast, Option.some(input)))
        }
        return Effect.mapBothEager(
          Parser.decodeEffect(exit)(input.exit, options),
          {
            onSuccess: (exit) => new Complete({ exit }),
            onFailure: (issue) =>
              new Issue.Composite(ast, Option.some(input), [
                new Issue.Pointer(["exit"], issue)
              ])
          }
        )
      },
      {
        expected: "Workflow.Complete",
        toCodecJson: ([exit]) =>
          Schema.link<Complete<Success["Encoded"], Error["Encoded"]>>()(
            Schema.Struct({
              _tag: Schema.tag("Complete"),
              exit
            }),
            Tranformation.transform({
              decode: (encoded) => new Complete({ exit: encoded.exit }),
              encode: (result) => (({
                _tag: "Complete",
                exit: result.exit
              }) as const)
            })
          )
      }
    )
    return Schema.make(schema.ast, {
      success: options.success,
      error: options.error
    })
  }
}

/**
 * Represents a suspended workflow execution, optionally carrying the cause that
 * triggered suspension.
 *
 * @category results
 * @since 4.0.0
 */
export class Suspended extends Schema.Class<Suspended>(
  "effect/workflow/Workflow/Suspended"
)({
  _tag: Schema.tag("Suspended"),
  cause: Schema.optional(Schema.Cause(Schema.Never, Schema.Defect))
}) {
  /**
   * Marks this value as a workflow result for runtime guards.
   *
   * @since 4.0.0
   */
  readonly [ResultTypeId] = ResultTypeId
}

/**
 * Creates a schema for workflow results using the supplied success and error
 * schemas.
 *
 * @category results
 * @since 4.0.0
 */
export const Result = <
  Success extends Schema.Top,
  Error extends Schema.Top
>(options: {
  readonly success: Success
  readonly error: Error
}) => Schema.Union([Complete.Schema(options), Suspended])

const AnyOrVoid = Schema.Union([Schema.Any, Schema.Void])

/**
 * Schema for encoded workflow results with generic success and error payloads.
 *
 * @category results
 * @since 4.0.0
 */
export const ResultEncoded: Schema.Codec<ResultEncoded<any, any>> = Schema.toEncoded(
  Schema.toCodecJson(
    Result({
      success: AnyOrVoid,
      error: AnyOrVoid
    })
  )
) as any

/**
 * Runs an effect as a workflow execution and converts its outcome into a
 * `Result`, handling suspension, defect capture, interruption, and workflow
 * scope finalization.
 *
 * @category results
 * @since 4.0.0
 */
export const intoResult = <A, E, R>(
  effect: Effect.Effect<A, E, R>
): Effect.Effect<
  Result<A, E>,
  never,
  Exclude<R, Scope.Scope> | WorkflowInstance
> =>
  Effect.contextWith((context: Context.Context<WorkflowInstance>) => {
    const instance = Context.get(context, InstanceTag)
    const captureDefects = Context.get(instance.workflow.annotations, CaptureDefects)
    const suspendOnFailure = Context.get(instance.workflow.annotations, SuspendOnFailure)
    return effect.pipe(
      // so we can use external interruption to suspend the workflow
      Effect.forkChild({ startImmediately: true }),
      Effect.flatMap((fiber) => Effect.onInterrupt(Fiber.join(fiber), () => Fiber.interrupt(fiber))),
      Effect.interruptible,
      suspendOnFailure
        ? Effect.catchCause((cause) => {
          instance.suspended = true
          if (!Cause.hasInterruptsOnly(cause)) {
            instance.cause = Cause.die(Cause.squash(cause))
          }
          return Effect.interrupt
        })
        : identity,
      Effect.scoped,
      Effect.matchCauseEffect({
        onSuccess: (value) => Effect.succeed(new Complete({ exit: Exit.succeed(value) })),
        onFailure: (cause): Effect.Effect<Result<A, E>> => {
          const [reasons, interrupts] = Arr.partition(
            cause.reasons,
            Filter.fromPredicate(Cause.isInterruptReason)
          )
          const hasInterruptsOnly = interrupts.length === cause.reasons.length
          const filtered = reasons.length === 0 ? cause : Cause.fromReasons(reasons)
          return instance.suspended && hasInterruptsOnly
            ? Effect.succeed(new Suspended({ cause: instance.cause }))
            : (!instance.interrupted && hasInterruptsOnly) ||
                (!captureDefects && Cause.hasDies(cause))
            ? Effect.failCause(filtered as Cause.Cause<never>)
            : Effect.succeed(new Complete({ exit: Exit.failCause(filtered) }))
        }
      }),
      (eff) =>
        Effect.onExitPrimitive(eff, (exit) => {
          if (Exit.isFailure(exit)) {
            return Scope.close(instance.scope, exit)
          } else if (exit.value._tag === "Complete") {
            return Scope.close(instance.scope, exit.value.exit)
          }
          return Effect.void
        }, true),
      Effect.uninterruptible
    )
  })

/**
 * Wraps an activity-like effect so workflow suspension waits for currently
 * running activities to finish or suspend.
 *
 * @category results
 * @since 4.0.0
 */
export const wrapActivityResult = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
  isSuspend: (value: A) => boolean
): Effect.Effect<A, E, R | WorkflowInstance> =>
  Effect.contextWith((context: Context.Context<WorkflowInstance>) => {
    const instance = Context.get(context, InstanceTag)
    const state = instance.activityState
    if (state.count === 0) state.latch.closeUnsafe()
    state.count++
    return Effect.onExit(effect, (exit) => {
      state.count--
      const isSuspended = Exit.isSuccess(exit) && isSuspend(exit.value)
      if (
        Exit.isSuccess(exit) &&
        isResult(exit.value) &&
        exit.value._tag === "Suspended" &&
        exit.value.cause
      ) {
        instance.cause = instance.cause
          ? Cause.combine(instance.cause, exit.value.cause)
          : exit.value.cause
      }
      return state.count === 0
        ? state.latch.open
        : isSuspended
        ? waitForZero(instance)
        : Effect.void
    })
  })

const waitForZero = Effect.fnUntraced(function*(instance: WorkflowInstance["Service"]) {
  const state = instance.activityState
  while (true) {
    if (state.count > 0) {
      yield* state.latch.await
      yield* Effect.yieldNow
      continue
    }
    yield* Effect.yieldNow
    if (state.count === 0) return
  }
})

/**
 * Accesses the workflow scope, which is only closed when the workflow execution fully completes.
 *
 * @category resource management
 * @since 4.0.0
 */
export const scope: Effect.Effect<
  Scope.Scope,
  never,
  WorkflowInstance
> = Effect.map(
  InstanceTag,
  (instance) => instance.scope as Scope.Scope
)

/**
 * Provides the workflow scope to the given effect, and closes the scope only when the workflow execution fully completes.
 *
 * @category resource management
 * @since 4.0.0
 */
export const provideScope = <A, E, R>(
  effect: Effect.Effect<A, E, R>
): Effect.Effect<A, E, Exclude<R, Scope.Scope> | WorkflowInstance> =>
  Effect.flatMap(scope, (scope) => Scope.provide(effect, scope))

/**
 * Adds an exit finalizer to the current workflow scope, preserving the
 * services available when the finalizer is registered.
 *
 * @category resource management
 * @since 4.0.0
 */
export const addFinalizer: <R>(
  f: (exit: Exit.Exit<unknown, unknown>) => Effect.Effect<void, never, R>
) => Effect.Effect<
  void,
  never,
  WorkflowInstance | R
> = Effect.fnUntraced(function*<R>(
  f: (exit: Exit.Exit<unknown, unknown>) => Effect.Effect<void, never, R>
) {
  const scope = (yield* InstanceTag).scope
  const services = yield* Effect.context<R>()
  yield* Scope.addFinalizerExit(scope, (exit) => Effect.provideContext(f(exit), services))
})

/**
 * Adds compensation logic to an effect inside a Workflow.
 *
 * **Details**
 *
 * The compensation finalizer is called if the entire workflow fails, allowing you to perform cleanup or other actions based on the success value and the cause of the workflow failure.
 *
 * **Gotchas**
 *
 * Compensation finalizers are only registered for top-level effects in the workflow and do not work for nested activities.
 *
 * @category Compensation
 * @since 4.0.0
 */
export const withCompensation: {
  <A, R2>(
    compensation: (value: A, cause: Cause.Cause<unknown>) => Effect.Effect<void, never, R2>
  ): <E, R>(
    effect: Effect.Effect<A, E, R>
  ) => Effect.Effect<A, E, R | R2 | WorkflowInstance | Scope.Scope>
  <A, E, R, R2>(
    effect: Effect.Effect<A, E, R>,
    compensation: (value: A, cause: Cause.Cause<unknown>) => Effect.Effect<void, never, R2>
  ): Effect.Effect<A, E, R | R2 | WorkflowInstance | Scope.Scope>
} = dual(2, <A, E, R, R2>(
  effect: Effect.Effect<A, E, R>,
  compensation: (value: A, cause: Cause.Cause<unknown>) => Effect.Effect<void, never, R2>
): Effect.Effect<A, E, R | R2 | WorkflowInstance | Scope.Scope> =>
  Effect.uninterruptibleMask((restore) =>
    Effect.tap(
      restore(effect),
      (value) => addFinalizer((exit) => Exit.isSuccess(exit) ? Effect.void : compensation(value, exit.cause))
    )
  ))

/**
 * Marks a workflow instance as suspended and interrupts the current fiber to
 * stop execution until it is resumed.
 *
 * @category results
 * @since 4.0.0
 */
export const suspend = (instance: WorkflowInstance["Service"]): Effect.Effect<never> =>
  Effect.interruptible(Effect.callback<never>(() => {
    instance.suspended = true
    const fiber = Fiber.getCurrent()!
    fiber.interruptUnsafe(fiber.id)
  }))

/**
 * Captures defects for a workflow and includes them in the result of the workflow or its activities.
 *
 * **Details**
 *
 * By default, this annotation is set to `true`, meaning defects are captured.
 *
 * @category annotations
 * @since 4.0.0
 */
export const CaptureDefects = Context.Reference<boolean>(
  "effect/workflow/Workflow/CaptureDefects",
  {
    defaultValue: constTrue
  }
)

/**
 * Marks a workflow to suspend when it encounters any error.
 *
 * **Details**
 *
 * The suspended execution can later be resumed with the workflow's `resume` method, for example `MyWorkflow.resume(executionId)`.
 *
 * @category annotations
 * @since 4.0.0
 */
export const SuspendOnFailure = Context.Reference<boolean>(
  "effect/workflow/Workflow/SuspendOnFailure",
  {
    defaultValue: constFalse
  }
)

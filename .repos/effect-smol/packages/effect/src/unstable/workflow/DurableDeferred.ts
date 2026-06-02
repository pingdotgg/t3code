/**
 * Durable deferreds are named workflow wait points whose result is stored by
 * the workflow engine as an encoded `Exit`. A workflow can `await` one and
 * suspend until an activity, worker, timer, or external callback completes it
 * with `done`, `succeed`, `fail`, or `failCause`.
 *
 * Use this module to coordinate work that finishes outside the current
 * workflow turn: durable races, queues that report worker results, timers,
 * human approvals, webhooks, and other callback-style integrations. Tokens
 * encode the workflow name, execution ID, and deferred name so completion can
 * be routed back to the correct workflow execution without keeping an
 * in-memory handle.
 *
 * Deferred names are part of persisted workflow state, so keep them stable
 * across replays and unique for each logical wait. Completion is persisted as
 * an `Exit` and decoded through the success and error schemas when awaited
 * again; changing schemas or reusing a name for a different result type can
 * make old completions fail to decode or resume the wrong wait. Complete a
 * deferred once, and use `withActivityAttempt` when an activity retry needs an
 * attempt-scoped completion name.
 *
 * @since 4.0.0
 */
import * as Arr from "../../Array.ts"
import type { NonEmptyReadonlyArray } from "../../Array.ts"
import type * as Brand from "../../Brand.ts"
import * as Cause from "../../Cause.ts"
import * as Context from "../../Context.ts"
import * as Effect from "../../Effect.ts"
import * as Encoding from "../../Encoding.ts"
import * as Exit from "../../Exit.ts"
import * as Filter from "../../Filter.ts"
import { dual } from "../../Function.ts"
import * as Option from "../../Option.ts"
import * as Schema from "../../Schema.ts"
import * as Getter from "../../SchemaGetter.ts"
import type * as Activity from "./Activity.ts"
import * as Workflow from "./Workflow.ts"
import type { WorkflowEngine, WorkflowInstance } from "./WorkflowEngine.ts"

const TypeId = "~effect/workflow/DurableDeferred"

/**
 * Named durable deferred value whose completion is persisted by the workflow
 * engine and encoded with success and error schemas.
 *
 * @category models
 * @since 4.0.0
 */
export interface DurableDeferred<
  Success extends Schema.Top,
  Error extends Schema.Top = Schema.Never
> {
  readonly [TypeId]: typeof TypeId
  readonly name: string
  readonly successSchema: Success
  readonly errorSchema: Error
  readonly exitSchema: Schema.Exit<Schema.Top, Schema.Top, Schema.Top>
  readonly withActivityAttempt: Effect.Effect<DurableDeferred<Success, Error>>
}

/**
 * Type-erased durable deferred shape for APIs that only need the deferred
 * identity and name.
 *
 * @category models
 * @since 4.0.0
 */
export interface Any {
  readonly [TypeId]: typeof TypeId
  readonly name: string
}

/**
 * Type-erased durable deferred shape that also exposes success, error, and
 * exit schemas.
 *
 * @category models
 * @since 4.0.0
 */
export interface AnyWithProps {
  readonly [TypeId]: typeof TypeId
  readonly name: string
  readonly successSchema: Schema.Top
  readonly errorSchema: Schema.Top
  readonly exitSchema: Schema.Exit<any, any, any>
}

/**
 * Creates a named durable deferred with optional success and error schemas for
 * persisted completion.
 *
 * @category constructors
 * @since 4.0.0
 */
export const make = <
  Success extends Schema.Top = Schema.Void,
  Error extends Schema.Top = Schema.Never
>(
  name: string,
  options?: {
    readonly success?: Success | undefined
    readonly error?: Error | undefined
  }
): DurableDeferred<Success, Error> => {
  const successSchema = options?.success ?? (Schema.Void as any as Success)
  const errorSchema = options?.error ?? (Schema.Never as any as Error)
  return {
    [TypeId]: TypeId as typeof TypeId,
    name,
    successSchema,
    errorSchema,
    exitSchema: Schema.Exit(
      Schema.toCodecJson(successSchema),
      Schema.toCodecJson(errorSchema),
      Schema.toCodecJson(Schema.Defect)
    ) as any,
    withActivityAttempt: Effect.gen(function*() {
      const attempt = yield* CurrentAttempt
      return make(`${name}/${attempt}`, {
        success: successSchema,
        error: errorSchema
      })
    })
  }
}

const EngineTag = Context.Service<WorkflowEngine, WorkflowEngine["Service"]>(
  "effect/workflow/WorkflowEngine" satisfies typeof WorkflowEngine.key
)

const InstanceTag = Context.Service<
  WorkflowInstance,
  WorkflowInstance["Service"]
>(
  "effect/workflow/WorkflowEngine/WorkflowInstance" satisfies typeof WorkflowInstance.key
)

const CurrentAttempt = Context.Reference<number>(
  "effect/workflow/Activity/CurrentAttempt" satisfies typeof Activity.CurrentAttempt.key,
  { defaultValue: () => 1 }
)

const await_: <Success extends Schema.Top, Error extends Schema.Top>(
  self: DurableDeferred<Success, Error>
) => Effect.Effect<
  Success["Type"],
  Error["Type"],
  | WorkflowEngine
  | WorkflowInstance
  | Success["DecodingServices"]
  | Error["DecodingServices"]
> = Effect.fnUntraced(function*<
  Success extends Schema.Top,
  Error extends Schema.Top
>(self: DurableDeferred<Success, Error>) {
  const engine = yield* EngineTag
  const instance = yield* InstanceTag
  const exit = yield* Workflow.wrapActivityResult(
    engine.deferredResult(self),
    Option.isNone
  )
  if (Option.isNone(exit)) {
    return yield* Workflow.suspend(instance)
  }
  return yield* exit.value as Exit.Exit<any, any>
})

export {
  /**
   * Waits for the durable deferred, suspending the current workflow when no
   * persisted completion is available.
   *
   * @category combinators
   * @since 4.0.0
   */
  await_ as await
}

/**
 * Runs an effect and records its exit into the durable deferred, resuming
 * workflows that are waiting on that deferred.
 *
 * @category combinators
 * @since 4.0.0
 */
export const into: {
  <Success extends Schema.Top, Error extends Schema.Top>(
    self: DurableDeferred<Success, Error>
  ): <R>(
    effect: Effect.Effect<Success["Type"], Error["Type"], R>
  ) => Effect.Effect<
    Success["Type"],
    Error["Type"],
    | R
    | WorkflowEngine
    | WorkflowInstance
    | Success["DecodingServices"]
    | Error["DecodingServices"]
  >
  <Success extends Schema.Top, Error extends Schema.Top, R>(
    effect: Effect.Effect<Success["Type"], Error["Type"], R>,
    self: DurableDeferred<Success, Error>
  ): Effect.Effect<
    Success["Type"],
    Error["Type"],
    | R
    | WorkflowEngine
    | WorkflowInstance
    | Success["DecodingServices"]
    | Error["DecodingServices"]
  >
} = dual(
  2,
  <Success extends Schema.Top, Error extends Schema.Top, R>(
    effect: Effect.Effect<Success["Type"], Error["Type"], R>,
    self: DurableDeferred<Success, Error>
  ): Effect.Effect<
    Success["Type"],
    Error["Type"],
    | R
    | WorkflowEngine
    | WorkflowInstance
    | Success["DecodingServices"]
    | Error["DecodingServices"]
  > =>
    Effect.contextWith(
      (context: Context.Context<WorkflowEngine | WorkflowInstance>) => {
        const engine = Context.get(context, EngineTag)
        const parentInstance = Context.get(context, InstanceTag)
        const instance = { ...parentInstance }
        return Effect.onExit(
          Effect.provideService(effect, InstanceTag, instance),
          Effect.fnUntraced(function*(exit) {
            if (Exit.isFailure(exit)) {
              const [reasons, interrupts] = Arr.partition(
                exit.cause.reasons,
                Filter.fromPredicate(Cause.isInterruptReason)
              )
              const hasInterruptsOnly = interrupts.length === exit.cause.reasons.length
              if (hasInterruptsOnly && instance.suspended) {
                parentInstance.suspended = true
                return
              } else if (interrupts.length > 0) {
                exit = Exit.failCause(Cause.fromReasons(reasons))
              }
            }
            yield* engine.deferredDone(self, {
              workflowName: instance.workflow.name,
              executionId: instance.executionId,
              deferredName: self.name,
              exit
            })
          })
        )
      }
    )
)

/**
 * Runs effects as a durable race, returning a previously persisted result when
 * present or completing a named deferred with the first result.
 *
 * @category Racing
 * @since 4.0.0
 */
export const raceAll = <
  const Effects extends NonEmptyReadonlyArray<Effect.Effect<any, any, any>>,
  Success extends Schema.Schema<Effect.Success<Effects[number]>>,
  Error extends Schema.Schema<Effect.Error<Effects[number]>>
>(options: {
  name: string
  success: Success
  error: Error
  effects: Effects
}): Effect.Effect<
  Effect.Success<Effects[number]>,
  Effect.Error<Effects[number]>,
  | Effect.Services<Effects[number]>
  | Success["DecodingServices"]
  | Success["EncodingServices"]
  | Error["DecodingServices"]
  | Error["EncodingServices"]
  | WorkflowEngine
  | WorkflowInstance
> => {
  const deferred = make<any, any>(`raceAll/${options.name}`, {
    success: options.success,
    error: options.error
  })
  return Effect.gen(function*() {
    const engine = yield* EngineTag
    const exit = yield* engine.deferredResult(deferred)
    if (Option.isSome(exit)) {
      return yield* Effect.flatten(exit.value) as Effect.Effect<any, any, any>
    }
    return yield* into(
      Effect.raceAll(options.effects),
      deferred
    )
  })
}

/**
 * Runtime brand identifier for durable deferred tokens.
 *
 * @category type IDs
 * @since 4.0.0
 */
export const TokenTypeId = "~effect/workflow/DurableDeferred/Token"

/**
 * Type-level brand identifier for `Token` values.
 *
 * @category type IDs
 * @since 4.0.0
 */
export type TokenTypeId = typeof TokenTypeId

/**
 * Branded string token identifying a durable deferred for a workflow
 * execution.
 *
 * @category token
 * @since 4.0.0
 */
export type Token = Brand.Branded<string, TokenTypeId>

/**
 * Schema for branded durable deferred tokens.
 *
 * @category token
 * @since 4.0.0
 */
export const Token: Schema.brand<Schema.String, TokenTypeId> = Schema.String.pipe(Schema.brand(TokenTypeId))

/**
 * Schema for a decoded durable deferred token containing the workflow
 * name, execution ID, and deferred name.
 *
 * @category token
 * @since 4.0.0
 */
export class TokenParsed extends Schema.Class<TokenParsed>(
  "effect/workflow/DurableDeferred/TokenParsed"
)({
  workflowName: Schema.String,
  executionId: Schema.String,
  deferredName: Schema.String
}) {
  /**
   * Encodes the parsed workflow, execution, and deferred names back into a token.
   *
   * @since 4.0.0
   */
  get asToken(): Token {
    return Encoding.encodeBase64Url(
      JSON.stringify([this.workflowName, this.executionId, this.deferredName])
    ) as Token
  }

  /**
   * Schema for decoding and encoding durable deferred tokens as strings.
   *
   * @since 4.0.0
   */
  static readonly FromString = Schema.String.pipe(
    Schema.decodeTo(
      Schema.fromJsonString(
        Schema.Tuple([Schema.String, Schema.String, Schema.String])
      ),
      {
        decode: Getter.decodeBase64UrlString(),
        encode: Getter.encodeBase64Url()
      }
    ),
    Schema.decodeTo(TokenParsed, {
      decode: Getter.transform(
        ([workflowName, executionId, deferredName]) =>
          new TokenParsed({
            workflowName,
            executionId,
            deferredName
          })
      ),
      encode: Getter.transform(
        (parsed) =>
          [
            parsed.workflowName,
            parsed.executionId,
            parsed.deferredName
          ] as const
      )
    })
  )

  /**
   * Decodes a durable deferred token string into its parsed components.
   *
   * @since 4.0.0
   */
  static readonly fromString = Schema.decodeSync(TokenParsed.FromString)

  /**
   * Encodes parsed durable deferred token components into a token string.
   *
   * @since 4.0.0
   */
  static readonly encode = Schema.encodeSync(TokenParsed.FromString)
}

/**
 * Creates a token for a durable deferred using the current workflow instance's
 * workflow name and execution ID.
 *
 * @category token
 * @since 4.0.0
 */
export const token: <Success extends Schema.Top, Error extends Schema.Top>(
  self: DurableDeferred<Success, Error>
) => Effect.Effect<Token, never, WorkflowInstance> = Effect.fnUntraced(
  function*<Success extends Schema.Top, Error extends Schema.Top>(
    self: DurableDeferred<Success, Error>
  ) {
    const instance = yield* InstanceTag
    return tokenFromExecutionId(self, instance)
  }
)

/**
 * Creates a durable deferred token from an explicit workflow, execution ID,
 * and deferred name.
 *
 * @category token
 * @since 4.0.0
 */
export const tokenFromExecutionId: {
  (options: {
    readonly workflow: Workflow.Any
    readonly executionId: string
  }): <Success extends Schema.Top, Error extends Schema.Top>(
    self: DurableDeferred<Success, Error>
  ) => Token
  <Success extends Schema.Top, Error extends Schema.Top>(
    self: DurableDeferred<Success, Error>,
    options: { readonly workflow: Workflow.Any; readonly executionId: string }
  ): Token
} = dual(
  2,
  <Success extends Schema.Top, Error extends Schema.Top>(
    self: DurableDeferred<Success, Error>,
    options: {
      readonly workflow: Workflow.Any
      readonly executionId: string
    }
  ): Token =>
    new TokenParsed({
      workflowName: options.workflow.name,
      executionId: options.executionId,
      deferredName: self.name
    }).asToken
)

/**
 * Creates a durable deferred token by deriving the workflow execution ID from
 * the supplied workflow payload.
 *
 * @category token
 * @since 4.0.0
 */
export const tokenFromPayload: {
  <W extends Workflow.Any>(options: {
    readonly workflow: W
    readonly payload: Workflow.PayloadSchema<W>["~type.make.in"]
  }): <Success extends Schema.Top, Error extends Schema.Top>(
    self: DurableDeferred<Success, Error>
  ) => Effect.Effect<Token>
  <
    Success extends Schema.Top,
    Error extends Schema.Top,
    W extends Workflow.Any
  >(
    self: DurableDeferred<Success, Error>,
    options: {
      readonly workflow: W
      readonly payload: Workflow.PayloadSchema<W>["~type.make.in"]
    }
  ): Effect.Effect<Token>
} = dual(
  2,
  <
    Success extends Schema.Top,
    Error extends Schema.Top,
    W extends Workflow.Any
  >(
    self: DurableDeferred<Success, Error>,
    options: {
      readonly workflow: W
      readonly payload: Workflow.PayloadSchema<W>["~type.make.in"]
    }
  ): Effect.Effect<Token> =>
    Effect.map(options.workflow.executionId(options.payload), (executionId) =>
      tokenFromExecutionId(self, {
        workflow: options.workflow,
        executionId
      }))
)

/**
 * Completes the durable deferred identified by a token with the supplied exit,
 * encoding the result through the deferred schemas.
 *
 * @category combinators
 * @since 4.0.0
 */
export const done: {
  <Success extends Schema.Top, Error extends Schema.Top>(options: {
    readonly token: Token
    readonly exit: Exit.Exit<Success["Type"], Error["Type"]>
  }): (
    self: DurableDeferred<Success, Error>
  ) => Effect.Effect<
    void,
    never,
    WorkflowEngine | Success["EncodingServices"] | Error["EncodingServices"]
  >
  <Success extends Schema.Top, Error extends Schema.Top>(
    self: DurableDeferred<Success, Error>,
    options: {
      readonly token: Token
      readonly exit: Exit.Exit<Success["Type"], Error["Type"]>
    }
  ): Effect.Effect<
    void,
    never,
    WorkflowEngine | Success["EncodingServices"] | Error["EncodingServices"]
  >
} = dual(
  2,
  Effect.fnUntraced(function*<
    Success extends Schema.Top,
    Error extends Schema.Top
  >(
    self: DurableDeferred<Success, Error>,
    options: {
      readonly token: Token
      readonly exit: Exit.Exit<Success["Type"], Error["Type"]>
    }
  ) {
    const engine = yield* EngineTag
    const token = TokenParsed.fromString(options.token)
    yield* engine.deferredDone(self, {
      workflowName: token.workflowName,
      executionId: token.executionId,
      deferredName: token.deferredName,
      exit: options.exit
    })
  })
)

/**
 * Completes the durable deferred identified by a token with a successful
 * value.
 *
 * @category combinators
 * @since 4.0.0
 */
export const succeed: {
  <Success extends Schema.Top, Error extends Schema.Top>(options: {
    readonly token: Token
    readonly value: Success["Type"]
  }): (
    self: DurableDeferred<Success, Error>
  ) => Effect.Effect<void, never, WorkflowEngine | Success["EncodingServices"]>
  <Success extends Schema.Top, Error extends Schema.Top>(
    self: DurableDeferred<Success, Error>,
    options: {
      readonly token: Token
      readonly value: Success["Type"]
    }
  ): Effect.Effect<void, never, WorkflowEngine | Success["EncodingServices"]>
} = dual(
  2,
  <Success extends Schema.Top, Error extends Schema.Top>(
    self: DurableDeferred<Success, Error>,
    options: {
      readonly token: Token
      readonly value: Success["Type"]
    }
  ): Effect.Effect<void, never, WorkflowEngine | Success["EncodingServices"]> =>
    done(self, {
      token: options.token,
      exit: Exit.succeed(options.value)
    })
)

/**
 * Completes the durable deferred identified by a token with a typed failure.
 *
 * @category combinators
 * @since 4.0.0
 */
export const fail: {
  <Success extends Schema.Top, Error extends Schema.Top>(options: {
    readonly token: Token
    readonly error: Error["Type"]
  }): (
    self: DurableDeferred<Success, Error>
  ) => Effect.Effect<void, never, WorkflowEngine | Error["EncodingServices"]>
  <Success extends Schema.Top, Error extends Schema.Top>(
    self: DurableDeferred<Success, Error>,
    options: {
      readonly token: Token
      readonly error: Error["Type"]
    }
  ): Effect.Effect<void, never, WorkflowEngine | Error["EncodingServices"]>
} = dual(
  2,
  <Success extends Schema.Top, Error extends Schema.Top>(
    self: DurableDeferred<Success, Error>,
    options: {
      readonly token: Token
      readonly error: Error["Type"]
    }
  ): Effect.Effect<void, never, WorkflowEngine | Error["EncodingServices"]> =>
    done(self, {
      token: options.token,
      exit: Exit.fail(options.error)
    })
)

/**
 * Completes the durable deferred identified by a token with a failure cause.
 *
 * @category combinators
 * @since 4.0.0
 */
export const failCause: {
  <Success extends Schema.Top, Error extends Schema.Top>(options: {
    readonly token: Token
    readonly cause: Cause.Cause<Error["Type"]>
  }): (
    self: DurableDeferred<Success, Error>
  ) => Effect.Effect<void, never, WorkflowEngine | Error["EncodingServices"]>
  <Success extends Schema.Top, Error extends Schema.Top>(
    self: DurableDeferred<Success, Error>,
    options: {
      readonly token: Token
      readonly cause: Cause.Cause<Error["Type"]>
    }
  ): Effect.Effect<void, never, WorkflowEngine | Error["EncodingServices"]>
} = dual(
  2,
  <Success extends Schema.Top, Error extends Schema.Top>(
    self: DurableDeferred<Success, Error>,
    options: {
      readonly token: Token
      readonly cause: Cause.Cause<Error["Type"]>
    }
  ): Effect.Effect<void, never, WorkflowEngine | Error["EncodingServices"]> =>
    done(self, {
      token: options.token,
      exit: Exit.failCause(options.cause)
    })
)

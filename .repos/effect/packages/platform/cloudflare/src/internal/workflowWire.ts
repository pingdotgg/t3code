/** @internal */
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Schema from "effect/Schema"
import * as Workflow from "effect/workflow/Workflow"
import { runWith } from "./entityWire.ts"

const AnyOrVoid = Schema.Union([Schema.Undefined, Schema.Any])

const ExitJson = Schema.toCodecJson(Schema.Exit(AnyOrVoid, AnyOrVoid, Schema.Defect()))

/** @internal */
export const encodeExit = (
  exit: Exit.Exit<unknown, unknown>,
  context: Context.Context<never>
): Effect.Effect<string> =>
  runWith(
    Effect.map(Schema.encodeUnknownEffect(ExitJson)(exit), (encoded) => JSON.stringify(encoded)),
    context
  )

/** @internal */
export const decodeExit = (
  text: string,
  context: Context.Context<never>
): Effect.Effect<Exit.Exit<unknown, unknown>> =>
  runWith(
    Schema.decodeUnknownEffect(ExitJson)(JSON.parse(text)) as Effect.Effect<Exit.Exit<unknown, unknown>, any>,
    context
  )

const cachedCodec = (compute: (workflow: Workflow.Any) => Schema.Top): (workflow: Workflow.Any) => Schema.Top => {
  const cache = new WeakMap<Workflow.Any, Schema.Top>()
  return (workflow) => {
    let codec = cache.get(workflow)
    if (codec === undefined) {
      codec = compute(workflow)
      cache.set(workflow, codec)
    }
    return codec
  }
}

const resultCodec = cachedCodec((workflow) =>
  Schema.toCodecJson(Workflow.Result({
    success: workflow.successSchema as any,
    error: workflow.errorSchema as any
  }))
)

const defectResultCodec = Schema.toCodecJson(Workflow.Result({ success: AnyOrVoid, error: AnyOrVoid }))

/**
 * Encodes a terminal `Complete(Die)` result. A defect never touches the
 * workflow's success or error schema, so this works without the workflow
 * definition, for example when none is registered.
 *
 * @internal
 */
export const encodeDefectResult = (defect: unknown): Effect.Effect<string> =>
  runWith(
    Effect.map(
      Schema.encodeUnknownEffect(defectResultCodec)(new Workflow.Complete({ exit: Exit.die(defect) })),
      (encoded) => JSON.stringify(encoded)
    ),
    Context.empty()
  )

const payloadCodec = cachedCodec((workflow) => Schema.toCodecJson(workflow.payloadSchema))

/** @internal */
export const encodeResult = (
  workflow: Workflow.Any,
  result: Workflow.Result<unknown, unknown>,
  context: Context.Context<never>
): Effect.Effect<string> =>
  runWith(
    Effect.map(
      Schema.encodeUnknownEffect(resultCodec(workflow))(result),
      (encoded) => JSON.stringify(encoded)
    ),
    context
  )

/** @internal */
export const decodeResult = (
  workflow: Workflow.Any,
  text: string,
  context: Context.Context<never>
): Effect.Effect<Workflow.Result<unknown, unknown>> =>
  runWith(
    Schema.decodeUnknownEffect(resultCodec(workflow))(JSON.parse(text)) as Effect.Effect<
      Workflow.Result<unknown, unknown>,
      any
    >,
    context
  )

/** @internal */
export const encodePayload = (
  workflow: Workflow.Any,
  payload: object,
  context: Context.Context<never>
): Effect.Effect<string> =>
  runWith(
    Effect.map(
      Schema.encodeUnknownEffect(payloadCodec(workflow))(payload),
      (encoded) => JSON.stringify(encoded)
    ),
    context
  )

/** @internal */
export const decodePayload = (
  workflow: Workflow.Any,
  text: string,
  context: Context.Context<never>
): Effect.Effect<object> =>
  runWith(
    Schema.decodeUnknownEffect(payloadCodec(workflow))(JSON.parse(text)) as Effect.Effect<object, any>,
    context
  )

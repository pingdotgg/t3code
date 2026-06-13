/**
 * The `WorkerError` module defines the typed error model shared by the
 * unstable worker APIs. Worker client and runner platforms use
 * {@link WorkerError} when platform setup, sending, receiving, or
 * runtime-specific worker behavior fails.
 *
 * **Mental model**
 *
 * - {@link WorkerError} is the outer error exposed in worker effect error
 *   channels
 * - {@link WorkerErrorReason} records one tagged reason: spawn, send,
 *   receive, or unknown
 * - The outer error delegates `message` and `cause` to the nested reason
 * - Reason schemas can be encoded and decoded when worker or RPC layers need
 *   structured diagnostics
 *
 * **Common tasks**
 *
 * - Detect worker failures with {@link isWorkerError}
 * - Classify startup and setup problems with {@link WorkerSpawnError}
 * - Classify `postMessage` or transfer-list failures with
 *   {@link WorkerSendError}
 * - Classify inbound event, `messageerror`, or worker-exit failures with
 *   {@link WorkerReceiveError}
 * - Preserve runtime-specific failures that do not fit another case with
 *   {@link WorkerUnknownError}
 *
 * **Gotchas**
 *
 * - The `cause` is diagnostic data and can have different shapes across
 *   browser, Node, Bun, and child-process transports
 * - A `WorkerSendError` often means the payload was invalid for the selected
 *   structured-clone or transfer-list rules
 * - A `WorkerSpawnError` can mean the runner code is not executing inside the
 *   expected worker context
 *
 * @since 4.0.0
 */
import { hasProperty } from "../../Predicate.ts"
import * as Schema from "../../Schema.ts"

const TypeId = "~effect/workers/WorkerError" as const

/**
 * Type-level identifier used to brand `WorkerError` values.
 *
 * @category type IDs
 * @since 4.0.0
 */
export type TypeId = typeof TypeId

/**
 * Returns `true` when a value is a `WorkerError`.
 *
 * @category guards
 * @since 4.0.0
 */
export const isWorkerError = (u: unknown): u is WorkerError => hasProperty(u, TypeId)

/**
 * Worker error reason for failures while spawning or setting up a worker.
 *
 * @category models
 * @since 4.0.0
 */
export class WorkerSpawnError extends Schema.ErrorClass<WorkerSpawnError>(
  "effect/workers/WorkerError/WorkerSpawnError"
)({
  _tag: Schema.tag("WorkerSpawnError"),
  message: Schema.String,
  cause: Schema.optional(Schema.Defect)
}) {}

/**
 * Worker error reason for failures while sending a message to a worker.
 *
 * @category models
 * @since 4.0.0
 */
export class WorkerSendError extends Schema.ErrorClass<WorkerSendError>(
  "effect/workers/WorkerError/WorkerSendError"
)({
  _tag: Schema.tag("WorkerSendError"),
  message: Schema.String,
  cause: Schema.optional(Schema.Defect)
}) {}

/**
 * Worker error reason for failures while receiving or handling a message from a
 * worker.
 *
 * @category models
 * @since 4.0.0
 */
export class WorkerReceiveError extends Schema.ErrorClass<WorkerReceiveError>(
  "effect/workers/WorkerError/WorkerReceiveError"
)({
  _tag: Schema.tag("WorkerReceiveError"),
  message: Schema.String,
  cause: Schema.optional(Schema.Defect)
}) {}

/**
 * Worker error reason for an unclassified worker failure.
 *
 * @category models
 * @since 4.0.0
 */
export class WorkerUnknownError extends Schema.ErrorClass<WorkerUnknownError>(
  "effect/workers/WorkerError/WorkerUnknownError"
)({
  _tag: Schema.tag("WorkerUnknownError"),
  message: Schema.String,
  cause: Schema.optional(Schema.Defect)
}) {}

/**
 * Union of the specific failure reasons that can be wrapped by a `WorkerError`.
 *
 * @category models
 * @since 4.0.0
 */
export type WorkerErrorReason =
  | WorkerSpawnError
  | WorkerSendError
  | WorkerReceiveError
  | WorkerUnknownError

/**
 * Schema for decoding and encoding all supported worker error reason variants.
 *
 * @category models
 * @since 4.0.0
 */
export const WorkerErrorReason: Schema.Union<[
  typeof WorkerSpawnError,
  typeof WorkerSendError,
  typeof WorkerReceiveError,
  typeof WorkerUnknownError
]> = Schema.Union([
  WorkerSpawnError,
  WorkerSendError,
  WorkerReceiveError,
  WorkerUnknownError
])

/**
 * Error raised by worker APIs, wrapping a specific `WorkerErrorReason` and
 * exposing its message and cause.
 *
 * @category models
 * @since 4.0.0
 */
export class WorkerError extends Schema.ErrorClass<WorkerError>(TypeId)({
  _tag: Schema.tag("WorkerError"),
  reason: WorkerErrorReason
}) {
  // @effect-diagnostics-next-line overriddenSchemaConstructor:off
  constructor(props: {
    readonly reason: WorkerErrorReason
  }) {
    super({
      ...props,
      cause: props.reason.cause
    } as any)
  }
  /**
   * Marks this value as a worker error for runtime guards.
   *
   * @since 4.0.0
   */
  readonly [TypeId]: TypeId = TypeId

  override get message(): string {
    return this.reason.message
  }
}

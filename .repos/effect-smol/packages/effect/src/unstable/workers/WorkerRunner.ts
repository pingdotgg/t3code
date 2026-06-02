/**
 * Platform-neutral primitives for code running inside worker-like runtimes.
 *
 * This module gives browser workers, shared workers, Node worker threads, Bun
 * workers, and child-process adapters the same server-side shape: start a
 * runner, receive messages tagged by a numeric port id, and send replies back
 * through the matching transport.
 *
 * **Mental model**
 *
 * `WorkerRunnerPlatform` is installed inside the worker-like runtime. Starting
 * it yields a `WorkerRunner`, and `WorkerRunner.run` attaches the message
 * handler. Incoming values use the small `PlatformMessage` protocol:
 * `[0, payload]` delivers a request and `[1]` closes a port. Higher-level
 * protocols, such as RPC over workers, decide how payloads are encoded before
 * they reach this layer.
 *
 * **Common tasks**
 *
 * - Start the current platform from the {@link WorkerRunnerPlatform} service
 * - Handle inbound messages with `WorkerRunner.run`
 * - Send responses or notifications with `WorkerRunner.send`
 * - Observe optional disconnect notifications through `WorkerRunner.disconnects`
 *
 * **Gotchas**
 *
 * This module does not serialize payloads; values must already be acceptable to
 * the selected runtime's message mechanism. Structured-clone support, transfer
 * lists, `messageerror` events, and single-port runtimes such as Node or Bun
 * all affect which payloads and resource lifetimes are safe. Handler effects
 * run on the runtime captured by `run`, so services required by a handler must
 * be provided to that running effect.
 *
 * @since 4.0.0
 */
import * as Context from "../../Context.ts"
import type * as Effect from "../../Effect.ts"
import type * as Queue from "../../Queue.ts"
import type { WorkerError } from "./WorkerError.ts"

/**
 * Platform-neutral worker runner that receives inbound messages by port ID,
 * sends outbound messages, and optionally exposes disconnect notifications.
 *
 * @category models
 * @since 4.0.0
 */
export interface WorkerRunner<O = unknown, I = unknown> {
  readonly run: <A, E, R>(
    handler: (portId: number, message: I) => Effect.Effect<A, E, R> | void
  ) => Effect.Effect<void, WorkerError, R>
  readonly send: (
    portId: number,
    message: O,
    transfers?: ReadonlyArray<unknown>
  ) => Effect.Effect<void>
  readonly sendUnsafe: (
    portId: number,
    message: O,
    transfers?: ReadonlyArray<unknown>
  ) => void
  readonly disconnects?: Queue.Dequeue<number> | undefined
}

/**
 * Wire protocol message used by worker platforms: a request carrying input or a
 * close signal.
 *
 * @category models
 * @since 4.0.0
 */
export type PlatformMessage<I> = readonly [request: 0, I] | readonly [close: 1]

/**
 * Context service that starts a platform-specific `WorkerRunner`.
 *
 * @category models
 * @since 4.0.0
 */
export class WorkerRunnerPlatform extends Context.Service<WorkerRunnerPlatform, {
  readonly start: <O = unknown, I = unknown>() => Effect.Effect<WorkerRunner<O, I>, WorkerError>
}>()("effect/workers/WorkerRunner/WorkerRunnerPlatform") {}

/**
 * Worker-entrypoint support for Bun worker runners.
 *
 * This module provides the Bun `WorkerRunnerPlatform` for code already running
 * inside a Bun `Worker`. It receives request messages from the parent-side
 * `BunWorker` platform, runs the handler registered with `WorkerRunner.run`,
 * and posts responses back through Bun's worker `postMessage` channel.
 *
 * **Mental model**
 *
 * The parent process installs `BunWorker.layer`; the worker entrypoint installs
 * this `layer` and starts `WorkerRunner`. Bun exposes one worker port to this
 * runner, so every message uses port id `0`. The first message sent by this
 * layer is the ready signal consumed by the parent platform before buffered
 * sends are flushed.
 *
 * **Common tasks**
 *
 * - Host Effect worker or RPC handlers inside a Bun worker entrypoint.
 * - Move CPU-bound work or Bun-only services behind Effect's worker protocol.
 * - Send structured-clone payloads and transferables back to the parent with
 *   `WorkerRunner.send`.
 *
 * **Gotchas**
 *
 * Start this layer only in the worker entrypoint; it fails when
 * `self.postMessage` is unavailable. Parent shutdown arrives as the worker
 * close message and closes the port, so long-running handlers should stay
 * interruptible and keep cleanup in scopes. Payloads, transfer lists, and
 * `messageerror` events follow Bun's worker runtime behavior.
 *
 * @see {@link layer} for the Bun worker-runner platform layer.
 *
 * @since 4.0.0
 */
import * as Cause from "effect/Cause"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Fiber from "effect/Fiber"
import { identity } from "effect/Function"
import * as Layer from "effect/Layer"
import * as Scope from "effect/Scope"
import { WorkerError, WorkerReceiveError, WorkerSpawnError } from "effect/unstable/workers/WorkerError"
import * as WorkerRunner from "effect/unstable/workers/WorkerRunner"

declare const self: MessagePort

/**
 * Provides the `WorkerRunnerPlatform` for code running inside a Bun worker,
 * routing parent messages to the registered handler and sending responses back
 * through the worker port.
 *
 * @category layers
 * @since 4.0.0
 */
export const layer: Layer.Layer<WorkerRunner.WorkerRunnerPlatform> = Layer.succeed(WorkerRunner.WorkerRunnerPlatform)({
  start: Effect.fnUntraced(function*<O = unknown, I = unknown>() {
    if (!("postMessage" in self)) {
      return yield* new WorkerError({
        reason: new WorkerSpawnError({ message: "not in a Worker context" })
      })
    }
    const port = self
    const run = <A, E, R>(
      handler: (portId: number, message: I) => Effect.Effect<A, E, R> | void
    ) =>
      Effect.scopedWith(Effect.fnUntraced(function*(scope) {
        const closeLatch = Deferred.makeUnsafe<void, WorkerError>()
        const trackFiber = Fiber.runIn(scope)
        const services = yield* Effect.context<R>()
        const runFork = Effect.runForkWith(services)
        const onExit = (exit: Exit.Exit<any, E>) => {
          if (exit._tag === "Failure" && !Cause.hasInterruptsOnly(exit.cause)) {
            runFork(Effect.logError("unhandled error in worker", exit.cause))
          }
        }

        function onMessage(event: MessageEvent) {
          const message = (event as MessageEvent).data as WorkerRunner.PlatformMessage<I>
          if (message[0] === 0) {
            const result = handler(0, message[1])
            if (Effect.isEffect(result)) {
              const fiber = runFork(result)
              fiber.addObserver(onExit)
              trackFiber(fiber)
            }
          } else {
            port.close()
            Deferred.doneUnsafe(closeLatch, Exit.void)
          }
        }
        function onMessageError(error: MessageEvent) {
          Deferred.doneUnsafe(
            closeLatch,
            new WorkerError({
              reason: new WorkerReceiveError({
                message: "received messageerror event",
                cause: error.data
              })
            })
          )
        }
        function onError(error: MessageEvent) {
          Deferred.doneUnsafe(
            closeLatch,
            new WorkerError({
              reason: new WorkerReceiveError({
                message: "received error event",
                cause: error.data
              })
            })
          )
        }
        yield* Scope.addFinalizer(
          scope,
          Effect.sync(() => {
            port.removeEventListener("message", onMessage)
            port.removeEventListener("messageerror", onError)
          })
        )
        port.addEventListener("message", onMessage)
        port.addEventListener("messageerror", onMessageError)
        port.postMessage([0])

        return yield* Deferred.await(closeLatch)
      }))

    const sendUnsafe = (_portId: number, message: O, transfer?: ReadonlyArray<unknown>) =>
      port.postMessage([1, message], {
        transfer: transfer as any
      })
    const send = (_portId: number, message: O, transfer?: ReadonlyArray<unknown>) =>
      Effect.sync(() => sendUnsafe(0, message, transfer))
    return identity<WorkerRunner.WorkerRunner<any, any>>({ run, send, sendUnsafe })
  })
})

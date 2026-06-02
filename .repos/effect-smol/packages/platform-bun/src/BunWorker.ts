/**
 * Parent-side worker support for Bun applications.
 *
 * This module provides the `WorkerPlatform` used by Bun programs that spawn and
 * communicate with `globalThis.Worker` instances through Effect's worker
 * protocol. Pair it with `BunWorkerRunner` in the worker entrypoint when
 * building worker-backed RPC clients, moving CPU-bound work off the main
 * thread, isolating Bun-only services, or hosting long-lived handlers behind a
 * typed message boundary.
 *
 * **Mental model**
 *
 * `layer(spawn)` installs both the Bun `WorkerPlatform` and a `Worker.Spawner`.
 * The supplied `spawn` function creates the Bun worker for each numeric worker
 * id. The platform listens for worker messages and errors, wraps outgoing data
 * in the Effect worker protocol, and buffers `send` calls until the worker
 * runner posts its ready signal.
 *
 * **Common tasks**
 *
 * - Run Effect worker clients in a Bun parent process.
 * - Move RPC handlers, CPU-bound computations, or Bun-only services into a
 *   dedicated worker.
 * - Provide custom worker creation logic while keeping message handling and
 *   cleanup inside Effect scopes.
 *
 * **Gotchas**
 *
 * This module is for the parent side only; the worker entrypoint must start
 * `BunWorkerRunner`. If the runner never starts or never posts readiness,
 * buffered messages will not be delivered. Payloads and transfer lists use
 * Bun's worker cloning and transfer semantics, so they must be accepted by the
 * Bun worker runtime. Scope finalization sends the Effect worker close signal,
 * waits for Bun's `close` event for a short grace period, and then terminates
 * the worker if graceful shutdown does not complete.
 *
 * @since 4.0.0
 */
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Layer from "effect/Layer"
import * as Scope from "effect/Scope"
import * as Worker from "effect/unstable/workers/Worker"
import { WorkerError, WorkerUnknownError } from "effect/unstable/workers/WorkerError"

/**
 * Provides the Bun `WorkerPlatform` together with a `Worker.Spawner` created
 * from the supplied worker spawning function.
 *
 * @category layers
 * @since 4.0.0
 */
export const layer = (
  spawn: (id: number) => globalThis.Worker
): Layer.Layer<Worker.WorkerPlatform | Worker.Spawner> =>
  Layer.merge(
    layerPlatform,
    Layer.succeed(Worker.Spawner)(spawn)
  )

/**
 * Provides the Bun `WorkerPlatform`, wiring worker messages and errors into
 * Effect workers and requesting graceful worker shutdown during scope
 * finalization before terminating on timeout.
 *
 * @category layers
 * @since 4.0.0
 */
export const layerPlatform = Layer.succeed(Worker.WorkerPlatform)(
  Worker.makePlatform<globalThis.Worker>()({
    setup({ scope, worker }) {
      const closeDeferred = Deferred.makeUnsafe<void>()
      worker.addEventListener("close", () => {
        Deferred.doneUnsafe(closeDeferred, Exit.void)
      })
      return Effect.as(
        Scope.addFinalizer(
          scope,
          Effect.suspend(() => {
            worker.postMessage([1])
            return Deferred.await(closeDeferred)
          }).pipe(
            Effect.interruptible,
            Effect.timeout(5000),
            Effect.catchCause(() => Effect.sync(() => worker.terminate()))
          )
        ),
        worker
      )
    },
    listen({ deferred, emit, port, scope }) {
      function onMessage(event: MessageEvent) {
        emit(event.data)
      }
      function onError(event: ErrorEvent) {
        Deferred.doneUnsafe(
          deferred,
          new WorkerError({
            reason: new WorkerUnknownError({
              message: "An error event was emitted",
              cause: event.error ?? event.message
            })
          })
        )
      }
      port.addEventListener("message", onMessage)
      port.addEventListener("error", onError)
      return Scope.addFinalizer(
        scope,
        Effect.sync(() => {
          port.removeEventListener("message", onMessage)
          port.removeEventListener("error", onError)
        })
      )
    }
  })
)

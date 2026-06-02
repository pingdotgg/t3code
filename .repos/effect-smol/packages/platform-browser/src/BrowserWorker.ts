/**
 * Parent-side browser platform for running Effect workers.
 *
 * This module provides the `WorkerPlatform` used by browser code that spawns or
 * connects to `Worker`, `SharedWorker`, and `MessagePort` endpoints through
 * Effect's worker protocol. Pair it with `BrowserWorkerRunner` in the worker
 * entrypoint when building worker-backed RPC clients, moving CPU-bound work off
 * the main thread, isolating browser-only services, or adapting an existing
 * `MessageChannel` in tests.
 *
 * **Mental model**
 *
 * Browser worker communication is normalized to a message port. Dedicated
 * workers post messages on the worker object itself, shared workers post
 * through `worker.port`, and raw `MessagePort` values can be supplied directly.
 * `layerPlatform` provides only the browser platform, while `layer` combines
 * the platform with a `Spawner` that creates a worker endpoint for each worker
 * id.
 *
 * **Common tasks**
 *
 * Use `layer` when parent code should both provide browser worker messaging and
 * define how workers are spawned. Use `layerPlatform` when a spawner is already
 * provided elsewhere. Return a `MessagePort` from the spawner for tests or
 * custom channels, a `Worker` for dedicated workers, or a `SharedWorker` when
 * multiple browser contexts should share one worker runtime.
 *
 * **Gotchas**
 *
 * Messages use the browser structured-clone algorithm, so payloads and transfer
 * lists must be accepted by the target runtime. Transferring an `ArrayBuffer` or
 * `MessagePort` moves ownership away from the sender. Scope finalization sends
 * the worker close signal over the port, but code that created a dedicated
 * `Worker` remains responsible for broader lifecycle concerns such as
 * terminating it.
 *
 * @since 4.0.0
 */
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Scope from "effect/Scope"
import * as Worker from "effect/unstable/workers/Worker"
import { WorkerError, WorkerReceiveError } from "effect/unstable/workers/WorkerError"

/**
 * Creates browser worker layers by combining the default `WorkerPlatform` with a spawner for `Worker`, `SharedWorker`, or `MessagePort` instances.
 *
 * **When to use**
 *
 * Use when browser parent or client code needs both the browser
 * `WorkerPlatform` and a `Spawner` from one layer.
 *
 * **Details**
 *
 * The `spawn` callback receives the numeric worker id and may return a
 * `Worker`, `SharedWorker`, or `MessagePort`.
 *
 * **Gotchas**
 *
 * Scope finalization sends the worker close protocol over the port. Dedicated
 * workers created by `spawn` are not terminated by this layer.
 *
 * @see {@link layerPlatform} for providing only the browser worker platform
 *
 * @category layers
 * @since 4.0.0
 */
export const layer = (
  spawn: (id: number) => Worker | SharedWorker | MessagePort
): Layer.Layer<Worker.WorkerPlatform | Worker.Spawner> =>
  Layer.merge(
    layerPlatform,
    Worker.layerSpawner(spawn)
  )

/**
 * Layer that provides the browser `WorkerPlatform` for `Worker`, `SharedWorker`, and `MessagePort` communication.
 *
 * @category layers
 * @since 4.0.0
 */
export const layerPlatform: Layer.Layer<Worker.WorkerPlatform> = Layer.succeed(Worker.WorkerPlatform)(
  Worker.makePlatform<globalThis.SharedWorker | globalThis.Worker | MessagePort>()({
    setup({ scope, worker }) {
      const port = "port" in worker ? worker.port : worker
      return Effect.as(
        Scope.addFinalizer(
          scope,
          Effect.sync(() => {
            port.postMessage([1])
          })
        ),
        port
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
            reason: new WorkerReceiveError({
              message: "An error event was emitter",
              cause: event.error ?? event.message
            })
          })
        )
      }
      port.addEventListener("message", onMessage as any)
      port.addEventListener("error", onError as any)
      if ("start" in port) {
        port.start()
      }
      return Scope.addFinalizer(
        scope,
        Effect.sync(() => {
          port.removeEventListener("message", onMessage as any)
          port.removeEventListener("error", onError as any)
        })
      )
    }
  })
)

/**
 * Node.js runtime support for workers that serve Effect worker requests.
 *
 * `NodeWorkerRunner` supplies the Node implementation of the Effect worker
 * runner platform. The exported `layer` runs inside a `node:worker_threads`
 * worker through `parentPort`, or inside a child process through
 * `process.send`. It listens for parent messages, runs handlers registered with
 * `WorkerRunner`, sends replies over the same channel, and closes when the
 * parent sends the close message.
 *
 * @since 4.0.0
 */
import * as Cause from "effect/Cause"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Fiber from "effect/Fiber"
import * as Layer from "effect/Layer"
import { WorkerError, WorkerReceiveError, WorkerSpawnError } from "effect/unstable/workers/WorkerError"
import * as WorkerRunner from "effect/unstable/workers/WorkerRunner"
import * as WorkerThreads from "node:worker_threads"

/**
 * Provides the `WorkerRunnerPlatform` for code running inside a Node worker
 * thread or child process, routing parent messages to the registered handler
 * and sending responses back through the parent channel.
 *
 * @category layers
 * @since 4.0.0
 */
export const layer: Layer.Layer<WorkerRunner.WorkerRunnerPlatform> = Layer.succeed(WorkerRunner.WorkerRunnerPlatform)({
  start<O = unknown, I = unknown>() {
    return Effect.gen(function*() {
      if (!WorkerThreads.parentPort && !process.send) {
        return yield* new WorkerError({
          reason: new WorkerSpawnError({ message: "not in a worker" })
        })
      }

      const sendUnsafe = WorkerThreads.parentPort
        ? (_portId: number, message: any, transfers?: any) => WorkerThreads.parentPort!.postMessage(message, transfers)
        : (_portId: number, message: any, _transfers?: any) => process.send!(message)
      const send = (_portId: number, message: O, transfers?: ReadonlyArray<unknown>) =>
        Effect.sync(() => sendUnsafe(_portId, [1, message], transfers as any))

      const run = <A, E, R>(
        handler: (portId: number, message: I) => Effect.Effect<A, E, R> | void
      ): Effect.Effect<void, WorkerError, R> =>
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
          ;(WorkerThreads.parentPort ?? process).on("message", (message: WorkerRunner.PlatformMessage<I>) => {
            if (message[0] === 0) {
              const result = handler(0, message[1])
              if (Effect.isEffect(result)) {
                const fiber = runFork(result)
                fiber.addObserver(onExit)
                trackFiber(fiber)
              }
            } else {
              if (WorkerThreads.parentPort) {
                WorkerThreads.parentPort.close()
              } else {
                process.channel?.unref()
              }
              Deferred.doneUnsafe(closeLatch, Exit.void)
            }
          })

          if (WorkerThreads.parentPort) {
            WorkerThreads.parentPort.on("messageerror", (cause) => {
              Deferred.doneUnsafe(
                closeLatch,
                new WorkerError({
                  reason: new WorkerReceiveError({
                    message: "received messageerror event",
                    cause
                  })
                })
              )
            })
            WorkerThreads.parentPort.on("error", (cause) => {
              Deferred.doneUnsafe(
                closeLatch,
                new WorkerError({
                  reason: new WorkerReceiveError({
                    message: "received messageerror event",
                    cause
                  })
                })
              )
            })
          }

          sendUnsafe(0, [0])

          return yield* Deferred.await(closeLatch)
        }))

      return { run, send, sendUnsafe }
    })
  }
})

/**
 * Runner-side browser platform for Effect worker handlers.
 *
 * This module is for code already executing inside a browser worker, or for
 * tests and adapters that pass a `MessagePort` or `Window` endpoint directly.
 * It provides the `WorkerRunnerPlatform` used by `WorkerRunner` and protocols
 * such as `RpcServer.layerProtocolWorkerRunner` to receive parent or client
 * requests, run Effect handlers, and post responses back through the browser
 * messaging channel.
 *
 * **Mental model**
 *
 * Dedicated workers use the ambient `self` endpoint. Shared workers receive one
 * `MessagePort` per `onconnect` event, and this module caches ports that arrive
 * before the runner layer starts. `layer` reads from the global worker `self`;
 * `make` and `layerMessagePort` are for explicit endpoints supplied by tests,
 * custom channels, or adapter code.
 *
 * **Common tasks**
 *
 * Pair this module with `BrowserWorker` in the parent page when moving RPC
 * handlers, CPU-bound computations, or browser-only services into a dedicated
 * worker or shared worker. Use `layer` in normal worker entry points and
 * `layerMessagePort` when a test or integration already owns the transport.
 *
 * **Gotchas**
 *
 * Payloads and transfer lists must satisfy the browser structured-clone
 * algorithm. `messageerror` and `error` events fail the runner, and each
 * connected `MessagePort` is closed when its scope finalizes.
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
import * as Queue from "effect/Queue"
import * as Scope from "effect/Scope"
import { WorkerError, WorkerReceiveError } from "effect/unstable/workers/WorkerError"
import * as WorkerRunner from "effect/unstable/workers/WorkerRunner"

const cachedPorts = new Set<MessagePort>()
function globalHandleConnect(event: MessageEvent) {
  cachedPorts.add((event as MessageEvent).ports[0])
}
if (typeof self !== "undefined" && "onconnect" in self) {
  self.onconnect = globalHandleConnect
}

/**
 * Creates a `WorkerRunnerPlatform` service that runs worker handlers over a `MessagePort` or `Window`.
 *
 * @category constructors
 * @since 4.0.0
 */
export const make = (self: MessagePort | Window): WorkerRunner.WorkerRunnerPlatform["Service"] => ({
  start: Effect.fnUntraced(function*<O = unknown, I = unknown>() {
    const disconnects = yield* Queue.make<number>()
    let currentPortId = 0

    const ports = new Map<number, readonly [MessagePort, Scope.Closeable]>()
    const sendUnsafe = (portId: number, message: O, transfer?: ReadonlyArray<unknown>) =>
      (ports.get(portId)?.[0] ?? self).postMessage([1, message], {
        transfer: transfer as any
      })
    const send = (portId: number, message: O, transfer?: ReadonlyArray<unknown>) =>
      Effect.sync(() => sendUnsafe(portId, message, transfer))

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

        function onMessage(portId: number) {
          return function(event: MessageEvent) {
            const message = event.data as WorkerRunner.PlatformMessage<I>
            if (message[0] === 0) {
              const result = handler(portId, message[1])
              if (Effect.isEffect(result)) {
                const fiber = runFork(result)
                fiber.addObserver(onExit)
                trackFiber(fiber)
              }
            } else {
              const port = ports.get(portId)
              if (!port) {
                return
              } else if (ports.size === 1) {
                // let the last port close with the outer scope
                return Deferred.doneUnsafe(closeLatch, Exit.void)
              }
              ports.delete(portId)
              Effect.runFork(Scope.close(port[1], Exit.void))
            }
          }
        }
        function onMessageError(error: MessageEvent) {
          Deferred.doneUnsafe(
            closeLatch,
            new WorkerError({
              reason: new WorkerReceiveError({
                message: "An messageerror event was emitted",
                cause: error.data
              })
            })
          )
        }
        function onError(error: any) {
          Deferred.doneUnsafe(
            closeLatch,
            new WorkerError({
              reason: new WorkerReceiveError({
                message: "An error event was emitted",
                cause: error.data
              })
            })
          )
        }
        function handlePort(port: MessagePort) {
          const portScope = Scope.forkUnsafe(scope)
          const portId = currentPortId++
          ports.set(portId, [port, portScope])
          const onMsg = onMessage(portId)
          port.addEventListener("message", onMsg)
          port.addEventListener("messageerror", onMessageError)
          if ("start" in port) {
            port.start()
          }
          port.postMessage([0])
          Effect.runSync(Scope.addFinalizer(
            portScope,
            Effect.sync(() => {
              port.removeEventListener("message", onMsg)
              port.removeEventListener("messageerror", onError)
              port.close()
            })
          ))
        }
        self.addEventListener("error", onError)
        let prevOnConnect: unknown | undefined
        if ("onconnect" in self) {
          prevOnConnect = self.onconnect
          self.onconnect = function(event: MessageEvent) {
            const port = (event as MessageEvent).ports[0]
            handlePort(port)
          }
          for (const port of cachedPorts) {
            handlePort(port)
          }
          cachedPorts.clear()
        } else {
          handlePort(self as any)
        }
        yield* Scope.addFinalizer(
          scope,
          Effect.sync(() => {
            self.removeEventListener("error", onError)
            if ("onconnect" in self) {
              self.close()
              self.onconnect = prevOnConnect
            }
          })
        )

        yield* Deferred.await(closeLatch)
      }))

    return identity<WorkerRunner.WorkerRunner<O, I>>({ run, send, sendUnsafe, disconnects })
  }) as any
})

/**
 * Layer that provides a browser `WorkerRunnerPlatform` using the global `self` worker context.
 *
 * **When to use**
 *
 * Use when a browser worker entry point uses the ambient `self` object as the
 * worker transport.
 *
 * **Details**
 *
 * Delegates to `make(self)` and provides the runner-side platform used by
 * protocols such as `RpcServer.layerProtocolWorkerRunner`.
 *
 * **Gotchas**
 *
 * This layer depends on the browser worker global `self`. Use
 * `layerMessagePort` when the transport is an explicit `MessagePort` or
 * `Window`.
 *
 * @see {@link make} for constructing a runner platform from an explicit endpoint
 * @see {@link layerMessagePort} for providing a platform from an explicit endpoint
 *
 * @category layers
 * @since 4.0.0
 */
export const layer: Layer.Layer<WorkerRunner.WorkerRunnerPlatform> = Layer.sync(WorkerRunner.WorkerRunnerPlatform)(() =>
  make(self)
)

/**
 * Layer that provides a `WorkerRunnerPlatform` using the supplied `MessagePort` or `Window`.
 *
 * @category layers
 * @since 4.0.0
 */
export const layerMessagePort = (port: MessagePort | Window): Layer.Layer<WorkerRunner.WorkerRunnerPlatform> =>
  Layer.succeed(WorkerRunner.WorkerRunnerPlatform)(make(port))

import * as Cause from "effect/Cause"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Fiber from "effect/Fiber"
import { pipe } from "effect/Function"
import * as References from "effect/References"
import * as Scope from "effect/Scope"
import * as Semaphore from "effect/Semaphore"
import type * as Socket from "effect/unstable/socket/Socket"
import * as SocketServer from "effect/unstable/socket/SocketServer"
import * as DenoSocket from "../DenoSocket.ts"

const initialBackoffMillis = 10
const maximumBackoffMillis = 1_000

type Listener = Deno.Listener<Deno.Conn, Deno.NetAddr | Deno.UnixAddr>

export const fromListener = (listener: Listener): SocketServer.SocketServer["Service"] => {
  const semaphore = Semaphore.makeUnsafe(1)

  const run = <R, E, _>(handler: (socket: Socket.Socket) => Effect.Effect<_, E, R>) =>
    semaphore.withPermit(Effect.gen(function*() {
      const scope = yield* Scope.make()
      const services = Context.omit(Scope.Scope)(yield* Effect.context<R>()) as Context.Context<R>
      const trackFiber = Fiber.runIn(scope)
      let failures = 0

      const loop: Effect.Effect<never> = Effect.suspend(() =>
        Effect.tryPromise(() => listener.accept()).pipe(
          Effect.matchEffect({
            onFailure: (error) => {
              const cause = error.cause
              if (isTeardownError(cause)) return Effect.never
              const backoff = Math.min(initialBackoffMillis * 2 ** failures++, maximumBackoffMillis)
              return reportUnhandledError(Cause.fail(cause)).pipe(
                Effect.andThen(Effect.sleep(backoff)),
                Effect.andThen(loop)
              )
            },
            onSuccess: (conn) => {
              failures = 0
              pipe(
                DenoSocket.fromConn(Effect.acquireRelease(Effect.succeed(conn), closeConn)),
                Effect.flatMap(handler),
                Effect.ensuring(closeConn(conn)),
                Effect.catchCause(reportUnhandledError),
                Effect.runForkWith(Context.add(services, DenoSocket.Conn, conn)),
                trackFiber
              )
              return loop
            }
          })
        )
      )

      return yield* loop.pipe(Effect.ensuring(Scope.close(scope, Exit.void)))
    }))

  const address = listener.addr
  return SocketServer.SocketServer.of({
    address: "path" in address
      ? { _tag: "UnixAddress", path: address.path }
      : { _tag: "TcpAddress", hostname: address.hostname, port: address.port },
    run
  })
}

export const closeListener = (listener: Listener): Effect.Effect<void> =>
  Effect.try(() => listener.close()).pipe(
    Effect.catch(({ cause }) => isTeardownError(cause) ? Effect.void : Effect.die(cause))
  )

const closeConn = (conn: Deno.Conn): Effect.Effect<void> =>
  Effect.try(() => conn.close()).pipe(
    Effect.catch(({ cause }) => isTeardownError(cause) ? Effect.void : Effect.die(cause))
  )

const isTeardownError = (cause: unknown): boolean =>
  cause instanceof Deno.errors.BadResource || cause instanceof Deno.errors.Interrupted

const reportUnhandledError = <E>(cause: Cause.Cause<E>) =>
  Effect.withFiber<void>((fiber) => {
    const unhandledLogLevel = fiber.getRef(References.UnhandledLogLevel)
    if (unhandledLogLevel) {
      return Effect.logWithLevel(unhandledLogLevel)(cause, "Unhandled error in SocketServer")
    }
    return Effect.void
  })

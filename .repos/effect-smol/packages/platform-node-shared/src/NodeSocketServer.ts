/**
 * Node socket server adapters for Effect's unstable socket server API.
 *
 * This module turns `node:net` TCP or Unix-domain servers and `ws` WebSocket
 * servers into scoped `SocketServer.SocketServer` services. Use the TCP
 * constructors when handlers should receive a `Socket.Socket` backed by a Node
 * `net.Socket`; use the WebSocket constructors when handlers should receive a
 * `Socket.Socket` backed by `ws` and have access to the per-connection
 * WebSocket and `IncomingMessage` services.
 *
 * @since 4.0.0
 */
import type { Cause } from "effect/Cause"
import * as Context from "effect/Context"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Fiber from "effect/Fiber"
import { pipe } from "effect/Function"
import * as Function from "effect/Function"
import * as Layer from "effect/Layer"
import * as References from "effect/References"
import * as Scope from "effect/Scope"
import * as Socket from "effect/unstable/socket/Socket"
import * as SocketServer from "effect/unstable/socket/SocketServer"
import type * as Http from "node:http"
import * as Net from "node:net"
import * as NodeSocket from "./NodeSocket.ts"
import { NodeWS } from "./NodeSocket.ts"

/**
 * Service tag for the Node `IncomingMessage` associated with the current
 * WebSocket server connection.
 *
 * @category services
 * @since 4.0.0
 */
export class IncomingMessage extends Context.Service<
  IncomingMessage,
  Http.IncomingMessage
>()("@effect/platform-node-shared/NodeSocketServer/IncomingMessage") {}

/**
 * Creates a scoped TCP `SocketServer` from a Node `net.Server`, starts
 * listening with the supplied options, queues pending connections until `run`
 * is called, and closes the server when the scope ends.
 *
 * @category constructors
 * @since 4.0.0
 */
export const make = Effect.fnUntraced(function*(
  options: Net.ServerOpts & Net.ListenOptions
) {
  const errorDeferred = Deferred.makeUnsafe<never, Error>()
  const pending = new Set<Net.Socket>()
  function defaultOnConnection(conn: Net.Socket) {
    pending.add(conn)
    const remove = () => {
      pending.delete(conn)
    }
    conn.on("close", remove)
    conn.on("error", remove)
  }
  let onConnection = defaultOnConnection
  // oxlint-disable-next-line prefer-const
  let server: Net.Server | undefined
  yield* Effect.addFinalizer(() =>
    Effect.callback<void>((resume) => {
      server?.close(() => resume(Effect.void))
    })
  )
  server = Net.createServer(options, (conn) => onConnection(conn))
  server.on("error", (err) => Deferred.doneUnsafe(errorDeferred, Exit.fail(err)))

  yield* Effect.callback<void, SocketServer.SocketServerError>((resume) => {
    server.listen(options, () => resume(Effect.void))
  }).pipe(
    Effect.raceFirst(Effect.mapError(Deferred.await(errorDeferred), (err) =>
      new SocketServer.SocketServerError({
        reason: new SocketServer.SocketServerOpenError({
          cause: err
        })
      })))
  )

  const run = Effect.fnUntraced(function*<R, E, _>(handler: (socket: Socket.Socket) => Effect.Effect<_, E, R>) {
    const scope = yield* Scope.make()
    const services = Context.omit(Scope.Scope)(yield* Effect.context<R>()) as Context.Context<R>
    const trackFiber = Fiber.runIn(scope)
    const prevOnConnection = onConnection
    onConnection = function(conn: Net.Socket) {
      let error: Error | undefined
      conn.on("error", (err) => {
        error = err
      })
      pipe(
        NodeSocket.fromDuplex(
          Effect.acquireRelease(
            Effect.suspend((): Effect.Effect<Net.Socket, Socket.SocketError> => {
              if (error) {
                return Effect.fail(
                  new Socket.SocketError({
                    reason: new Socket.SocketOpenError({
                      kind: "Unknown",
                      cause: error
                    })
                  })
                )
              } else if (conn.closed) {
                return Effect.fail(
                  new Socket.SocketError({
                    reason: new Socket.SocketCloseError({ code: 1000 })
                  })
                )
              }
              return Effect.succeed(conn)
            }),
            (conn) =>
              Effect.sync(() => {
                if (conn.closed === false) {
                  conn.destroySoon()
                }
              })
          )
        ),
        Effect.flatMap(handler),
        Effect.catchCause(reportUnhandledError),
        Effect.runForkWith(Context.add(services, NodeSocket.NetSocket, conn)),
        trackFiber
      )
    }
    pending.forEach((conn) => {
      conn.removeAllListeners("error")
      conn.removeAllListeners("close")
      onConnection(conn)
    })
    pending.clear()
    return yield* Effect.callback<never>((_resume) => {
      return Effect.suspend(() => {
        onConnection = prevOnConnection
        return Scope.close(scope, Exit.void)
      })
    })
  })

  const address = server.address()!
  return SocketServer.SocketServer.of({
    address: typeof address === "string" ?
      {
        _tag: "UnixAddress",
        path: address
      } :
      {
        _tag: "TcpAddress",
        hostname: address.address,
        port: address.port
      },
    run
  })
})

/**
 * Provides a TCP `SocketServer` by creating and managing a scoped Node
 * `net.Server` with the supplied server and listen options.
 *
 * @category layers
 * @since 4.0.0
 */
export const layer: (
  options: Net.ServerOpts & Net.ListenOptions
) => Layer.Layer<
  SocketServer.SocketServer,
  SocketServer.SocketServerError
> = Function.flow(make, Layer.effect(SocketServer.SocketServer))

/**
 * Creates a scoped WebSocket `SocketServer` backed by the `ws` package,
 * providing the WebSocket and its Node `IncomingMessage` to connection
 * handlers and closing the server when the scope ends.
 *
 * @category constructors
 * @since 4.0.0
 */
export const makeWebSocket: (
  options: NodeWS.ServerOptions<typeof NodeWS.WebSocket, typeof Http.IncomingMessage>
) => Effect.Effect<
  SocketServer.SocketServer["Service"],
  SocketServer.SocketServerError,
  Scope.Scope
> = Effect.fnUntraced(function*(
  options: NodeWS.ServerOptions
) {
  const server = yield* Effect.acquireRelease(
    Effect.sync(() => new NodeWS.WebSocketServer(options)),
    (server) =>
      Effect.callback<void>((resume) => {
        server.close(() => resume(Effect.void))
      })
  )
  const pendingConnections = new Set<readonly [globalThis.WebSocket, Http.IncomingMessage]>()
  function defaultHandler(conn: globalThis.WebSocket, req: Http.IncomingMessage) {
    const entry = [conn, req] as const
    pendingConnections.add(entry)
    conn.addEventListener("close", () => {
      pendingConnections.delete(entry)
    })
  }
  let onConnection = defaultHandler
  server.on("connection", (conn, req) => onConnection(conn as any, req))

  yield* Effect.callback<void, SocketServer.SocketServerError>((resume) => {
    server.once("error", (error) => {
      resume(Effect.fail(
        new SocketServer.SocketServerError({
          reason: new SocketServer.SocketServerOpenError({
            cause: error
          })
        })
      ))
    })
    server.once("listening", () => {
      resume(Effect.void)
    })
  })

  const run = Effect.fnUntraced(function*<R, E, _>(handler: (socket: Socket.Socket) => Effect.Effect<_, E, R>) {
    const scope = yield* Scope.make()
    const services = Context.omit(Scope.Scope)(yield* Effect.context<R>()) as Context.Context<R>
    const trackFiber = Fiber.runIn(scope)
    const prevOnConnection = onConnection
    onConnection = function(conn: globalThis.WebSocket, req: Http.IncomingMessage) {
      const map = new Map(services.mapUnsafe)
      map.set(IncomingMessage.key, req)
      map.set(Socket.WebSocket.key, conn as any)
      pipe(
        Socket.fromWebSocket(
          Effect.acquireRelease(
            Effect.succeed(conn),
            (conn) =>
              Effect.sync(() => {
                conn.close()
              })
          )
        ),
        Effect.flatMap(handler),
        Effect.catchCause(reportUnhandledError),
        Effect.runForkWith(Context.makeUnsafe(map)),
        trackFiber
      )
    }
    for (const [conn, req] of pendingConnections) {
      onConnection(conn, req)
    }
    pendingConnections.clear()
    return yield* Effect.callback<never>((_resume) => {
      return Effect.sync(() => {
        onConnection = prevOnConnection
      })
    }).pipe(
      Effect.ensuring(Scope.close(scope, Exit.void))
    )
  })

  const address = server.address()!
  return SocketServer.SocketServer.of({
    address: typeof address === "string" ?
      {
        _tag: "UnixAddress",
        path: address
      } :
      {
        _tag: "TcpAddress",
        hostname: address.address,
        port: address.port
      },
    run
  })
})

/**
 * Provides a WebSocket `SocketServer` backed by the `ws` package and managed
 * with the supplied server options.
 *
 * @category layers
 * @since 4.0.0
 */
export const layerWebSocket: (
  options: NodeSocket.NodeWS.ServerOptions<typeof NodeSocket.NodeWS.WebSocket, typeof Http.IncomingMessage>
) => Layer.Layer<
  SocketServer.SocketServer,
  SocketServer.SocketServerError
> = Function.flow(makeWebSocket, Layer.effect(SocketServer.SocketServer))

const reportUnhandledError = <E>(cause: Cause<E>) =>
  Effect.withFiber<void>((fiber) => {
    const unhandledLogLevel = fiber.getRef(References.UnhandledLogLevel)
    if (unhandledLogLevel) {
      return Effect.logWithLevel(unhandledLogLevel)(cause, "Unhandled error in SocketServer")
    }
    return Effect.void
  })

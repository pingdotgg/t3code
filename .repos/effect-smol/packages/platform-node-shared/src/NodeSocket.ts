/**
 * Node socket adapters for Effect sockets.
 *
 * This module opens `node:net` connections or wraps existing Node `Duplex`
 * streams and presents them as `Socket.Socket` values, socket channels, or
 * layers. It is the low-level bridge for TCP clients, Unix domain socket
 * clients, and protocols that already expose a Node duplex stream.
 *
 * **Mental model**
 *
 * A socket acquired here is scoped. `makeNet` dials with
 * `net.createConnection`, `fromDuplex` adapts any duplex returned by an Effect,
 * `makeNetChannel` exposes the socket as a `Channel`, and `layerNet` provides
 * it through the Effect environment. While a socket handler is running,
 * `NetSocket` gives access to the underlying Node `net.Socket` for cases that
 * need Node-specific operations.
 *
 * **Gotchas**
 *
 * `openTimeout` only limits opening the connection. Writes complete when Node
 * accepts or flushes a chunk, close events are translated to `SocketError`
 * values, and finalizers close or destroy the stream when the surrounding scope
 * ends. Unix socket paths are supplied through `NetConnectOpts.path`, so use
 * the same platform path rules as Node.
 *
 * @since 4.0.0
 */
import type { Array } from "effect"
import * as Channel from "effect/Channel"
import * as Context from "effect/Context"
import * as Deferred from "effect/Deferred"
import type * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as FiberSet from "effect/FiberSet"
import * as Function from "effect/Function"
import { identity } from "effect/Function"
import * as Latch from "effect/Latch"
import * as Layer from "effect/Layer"
import * as Scope from "effect/Scope"
import * as Socket from "effect/unstable/socket/Socket"
import * as Net from "node:net"
import type { Duplex } from "node:stream"

/**
 * @category re-exports
 * @since 4.0.0
 */
export * as NodeWS from "ws"

/**
 * Service tag for the underlying Node `net.Socket` associated with the current
 * socket connection.
 *
 * @category tags
 * @since 4.0.0
 */
export class NetSocket extends Context.Service<NetSocket, Net.Socket>()(
  "@effect/platform-node/NodeSocket/NetSocket"
) {}

/**
 * Opens a Node TCP connection as an Effect socket.
 *
 * **When to use**
 *
 * Use to create a scoped `Socket.Socket` from Node `net.createConnection`.
 *
 * **Details**
 *
 * Supports `openTimeout` and closes or destroys the underlying socket when the
 * enclosing scope is finalized.
 *
 * @category constructors
 * @since 4.0.0
 */
export const makeNet = (
  options: Net.NetConnectOpts & {
    readonly openTimeout?: Duration.Input | undefined
  }
): Effect.Effect<Socket.Socket> =>
  fromDuplex(
    Effect.contextWith((context: Context.Context<Scope.Scope>) => {
      let conn: Net.Socket | undefined
      return Effect.flatMap(
        Scope.addFinalizer(
          Context.get(context, Scope.Scope),
          Effect.sync(() => {
            if (!conn) return
            if (conn.closed === false) {
              if ("destroySoon" in conn) {
                conn.destroySoon()
              } else {
                ;(conn as Net.Socket).destroy()
              }
            }
          })
        ),
        () =>
          Effect.callback<Net.Socket, Socket.SocketError, never>((resume) => {
            conn = Net.createConnection(options)
            conn.once("connect", () => {
              resume(Effect.succeed(conn!))
            })
            conn.on("error", (cause: Error) => {
              resume(Effect.fail(
                new Socket.SocketError({
                  reason: new Socket.SocketOpenError({ kind: "Unknown", cause })
                })
              ))
            })
          })
      )
    }),
    options
  )

/**
 * Adapts a Node `Duplex` into a `Socket.Socket`, wiring data events to socket
 * handlers, providing a scoped writer, and mapping open, read, write, and close
 * failures to `SocketError`.
 *
 * @category constructors
 * @since 4.0.0
 */
export const fromDuplex = <RO>(
  open: Effect.Effect<Duplex, Socket.SocketError, RO>,
  options?: {
    readonly openTimeout?: Duration.Input | undefined
  }
): Effect.Effect<Socket.Socket, never, Exclude<RO, Scope.Scope>> =>
  Effect.withFiber<Socket.Socket, never, Exclude<RO, Scope.Scope>>((fiber) => {
    let currentSocket: Duplex | undefined
    const latch = Latch.makeUnsafe(false)
    const openServices = fiber.context as Context.Context<RO>

    const run = <R, E, _>(handler: (_: Uint8Array) => Effect.Effect<_, E, R> | void, opts?: {
      readonly onOpen?: Effect.Effect<void> | undefined
    }) =>
      Effect.scopedWith(Effect.fnUntraced(function*(scope) {
        const fiberSet = yield* FiberSet.make<any, E | Socket.SocketError>().pipe(
          Scope.provide(scope)
        )
        let conn: Duplex | undefined = undefined
        yield* Scope.addFinalizer(
          scope,
          Effect.sync(() => {
            if (!conn) return
            conn.off("data", onData)
            conn.off("end", onEnd)
            conn.off("error", onError)
            conn.off("close", onClose)
          })
        )
        conn = yield* Scope.provide(open, scope).pipe(
          options?.openTimeout ?
            Effect.timeoutOrElse({
              duration: options.openTimeout,
              orElse: () =>
                Effect.fail(
                  new Socket.SocketError({
                    reason: new Socket.SocketOpenError({ kind: "Timeout", cause: new Error("Connection timed out") })
                  })
                )
            }) :
            identity
        )
        conn.on("end", onEnd)
        conn.on("error", onError)
        conn.on("close", onClose)
        const run = yield* Effect.provideService(FiberSet.runtime(fiberSet)<R>(), NetSocket, conn as Net.Socket)
        conn.on("data", onData)

        currentSocket = conn
        latch.openUnsafe()
        if (opts?.onOpen) {
          yield* opts.onOpen
        }

        return yield* FiberSet.join(fiberSet)

        function onData(chunk: Uint8Array) {
          const result = handler(chunk)
          if (Effect.isEffect(result)) {
            run(result)
          }
        }
        function onEnd() {
          Deferred.doneUnsafe(fiberSet.deferred, Effect.void)
        }
        function onError(cause: Error) {
          Deferred.doneUnsafe(
            fiberSet.deferred,
            Effect.fail(
              new Socket.SocketError({
                reason: new Socket.SocketReadError({ cause })
              })
            )
          )
        }
        function onClose(hadError: boolean) {
          Deferred.doneUnsafe(
            fiberSet.deferred,
            Effect.fail(
              new Socket.SocketError({
                reason: new Socket.SocketCloseError({ code: hadError ? 1006 : 1000 })
              })
            )
          )
        }
      })).pipe(
        Effect.updateContext((input: Context.Context<R>) => Context.merge(openServices, input)),
        Effect.onExit(() =>
          Effect.sync(() => {
            latch.closeUnsafe()
            currentSocket = undefined
          })
        )
      )

    const write = (chunk: Uint8Array | string | Socket.CloseEvent) =>
      latch.whenOpen(Effect.callback<void, Socket.SocketError>((resume) => {
        const conn = currentSocket!
        if (Socket.isCloseEvent(chunk)) {
          conn.destroy(chunk.code > 1000 ? new Error(`closed with code ${chunk.code}`) : undefined)
          return resume(Effect.void)
        }
        currentSocket!.write(chunk, (cause) => {
          resume(
            cause
              ? Effect.fail(
                new Socket.SocketError({
                  reason: new Socket.SocketWriteError({ cause: cause! })
                })
              )
              : Effect.void
          )
        })
      }))

    const writer = Effect.acquireRelease(
      Effect.succeed(write),
      () =>
        Effect.sync(() => {
          if (!currentSocket || currentSocket.writableEnded) return
          currentSocket.end()
        })
    )

    return Effect.succeed(Socket.make({
      run,
      runRaw: run,
      writer
    }))
  })

/**
 * Creates a `Channel` over a TCP socket, reading arrays of `Uint8Array`
 * chunks and writing arrays of bytes, strings, or socket close events.
 *
 * @category constructors
 * @since 4.0.0
 */
export const makeNetChannel = <IE = never>(
  options: Net.NetConnectOpts
): Channel.Channel<
  Array.NonEmptyReadonlyArray<Uint8Array>,
  Socket.SocketError | IE,
  void,
  Array.NonEmptyReadonlyArray<Uint8Array | string | Socket.CloseEvent>,
  IE
> =>
  Channel.unwrap(
    Effect.map(makeNet(options), Socket.toChannelWith<IE>())
  )

/**
 * Provides a `Socket.Socket` by opening a TCP connection with the supplied
 * Node `net` connection options.
 *
 * @category layers
 * @since 4.0.0
 */
export const layerNet: (options: Net.NetConnectOpts) => Layer.Layer<
  Socket.Socket,
  Socket.SocketError
> = Function.flow(makeNet, Layer.effect(Socket.Socket))

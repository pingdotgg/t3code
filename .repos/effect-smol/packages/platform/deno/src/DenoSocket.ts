/**
 * Native Deno socket adapters for Effect sockets.
 *
 * This module uses Deno-specific names: `makeTcp`, `makeTcpChannel`,
 * `layerTcp`, and `fromConn` correspond to the Node platform's net and duplex
 * APIs. Deno does not support `keepAliveInitialDelay`, and the `noDelay` and
 * `keepAlive` options have no effect on Unix connections. A `CloseEvent` always
 * closes gracefully because Deno has no equivalent of Node's reset-on-close.
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
import * as Latch from "effect/Latch"
import * as Layer from "effect/Layer"
import * as Scope from "effect/Scope"
import * as Socket from "effect/unstable/socket/Socket"

/**
 * Options for opening a TCP or Unix connection.
 *
 * @category options
 * @since 4.0.0
 */
export type ConnectOptions = (Deno.ConnectOptions | Deno.UnixConnectOptions) & {
  readonly noDelay?: boolean | undefined
  readonly keepAlive?: boolean | undefined
}

/**
 * Options for opening a TCP or Unix connection.
 *
 * @category options
 * @since 4.0.0
 */
export type TcpOptions = ConnectOptions & {
  readonly openTimeout?: Duration.Input | undefined
}

/**
 * Service tag for the underlying Deno connection.
 *
 * @category services
 * @since 4.0.0
 */
export class Conn extends Context.Service<Conn, Deno.Conn>()(
  "@effect/platform-deno/DenoSocket/Conn"
) {}

/**
 * Adapts a Deno connection into an Effect socket.
 *
 * @category constructors
 * @since 4.0.0
 */
export const fromConn = <RO>(
  open: Effect.Effect<Deno.Conn, Socket.SocketError, RO>
): Effect.Effect<Socket.Socket, never, Exclude<RO, Scope.Scope>> =>
  Effect.withFiber<Socket.Socket, never, Exclude<RO, Scope.Scope>>((fiber) => {
    let current: {
      readonly conn: Deno.Conn
      readonly writer: WritableStreamDefaultWriter<Uint8Array>
    } | undefined
    let tearingDown = false
    let writeClosed = false
    const latch = Latch.makeUnsafe(false)
    const openServices = fiber.context as Context.Context<RO>

    const run = <R, E, _>(handler: (_: Uint8Array) => Effect.Effect<_, E, R> | void, options?: {
      readonly onOpen?: Effect.Effect<void> | undefined
    }) =>
      Effect.scopedWith(Effect.fnUntraced(function*(scope) {
        const fiberSet = yield* FiberSet.make<any, E | Socket.SocketError>().pipe(
          Scope.provide(scope)
        )
        let conn: Deno.Conn | undefined
        yield* Scope.addFinalizer(
          scope,
          Effect.suspend(() => {
            tearingDown = true
            return conn === undefined ? Effect.void : close(conn)
          })
        )
        conn = yield* Scope.provide(open, scope)
        const reader = conn.readable.getReader()
        const writer = conn.writable.getWriter()
        const runFork = yield* Effect.provideService(FiberSet.runtime(fiberSet)<R>(), Conn, conn)

        current = { conn, writer }
        tearingDown = false
        if (writeClosed) {
          writeClosed = false
          writer.releaseLock()
          yield* closeWrite(conn)
        }
        latch.openUnsafe()

        const read = Effect.tryPromise(
          () => reader.read()
        ).pipe(
          Effect.catchIf(
            (error) => tearingDown && isTeardownError(error.cause),
            () => Effect.succeed({ done: true, value: undefined } as ReadableStreamReadDoneResult<Uint8Array>)
          ),
          Effect.mapError((error) =>
            new Socket.SocketError({
              reason: new Socket.SocketReadError({ cause: error.cause })
            })
          )
        )
        const readLoop: Effect.Effect<void, Socket.SocketError> = Effect.suspend(() =>
          Effect.flatMap(read, ({ done, value }) => {
            if (done) {
              Deferred.doneUnsafe(fiberSet.deferred, Effect.void)
              return Effect.void
            }
            const result = handler(value)
            if (Effect.isEffect(result)) {
              runFork(result)
            }
            return readLoop
          })
        )
        yield* FiberSet.run(fiberSet, readLoop)

        if (options?.onOpen) {
          yield* options.onOpen
        }
        return yield* FiberSet.join(fiberSet)
      })).pipe(
        Effect.updateContext((input: Context.Context<R>) => Context.merge(openServices, input)),
        Effect.onExit(() =>
          Effect.sync(() => {
            tearingDown = true
            latch.closeUnsafe()
            current = undefined
          })
        )
      )

    const write = (chunk: Uint8Array | string | Socket.CloseEvent) =>
      latch.whenOpen(Effect.suspend(() => {
        const { conn, writer } = current!
        if (Socket.isCloseEvent(chunk)) {
          tearingDown = true
          return close(conn)
        }
        const bytes = typeof chunk === "string" ? encoder.encode(chunk) : chunk
        return Effect.tryPromise({
          try: () => writer.ready.then(() => writer.write(bytes)),
          catch: (cause) =>
            new Socket.SocketError({
              reason: new Socket.SocketWriteError({ cause })
            })
        })
      }))

    const writer = Effect.acquireRelease(
      Effect.sync(() => {
        writeClosed = false
        return write
      }),
      () =>
        Effect.suspend(() => {
          if (current === undefined) {
            writeClosed = true
            return Effect.void
          }
          const { conn, writer } = current
          writer.releaseLock()
          return closeWrite(conn)
        })
    )

    return Effect.succeed(Socket.make({
      run,
      runRaw: run,
      writer
    }))
  })

/**
 * Opens a native Deno TCP or Unix connection as an Effect socket.
 *
 * **Details**
 *
 * An `openTimeout` interrupts acquisition but cannot cancel the in-flight
 * `Deno.connect` promise. The scope finalizer closes a connection that arrives
 * after the timeout.
 *
 * @category constructors
 * @since 4.0.0
 */
export const makeTcp = (options: TcpOptions): Effect.Effect<Socket.Socket> => {
  const { keepAlive, noDelay, openTimeout, ...connectOptions } = options
  const acquire = Effect.contextWith((context: Context.Context<Scope.Scope>) => {
    let conn: Deno.Conn | undefined
    let finalized = false
    return Scope.addFinalizer(
      Context.get(context, Scope.Scope),
      Effect.suspend(() => {
        finalized = true
        return conn === undefined ? Effect.void : close(conn)
      })
    ).pipe(
      Effect.andThen(Effect.tryPromise({
        try: () => {
          const connecting = connectOptions.transport === "unix"
            ? Deno.connect(connectOptions)
            : Deno.connect(connectOptions)
          return connecting.then((connection) => {
            conn = connection
            if (finalized) connection.close()
            return connection
          })
        },
        catch: (cause) =>
          new Socket.SocketError({
            reason: new Socket.SocketOpenError({ kind: "Unknown", cause })
          })
      })),
      Effect.tap((connection) =>
        Effect.sync(() => {
          if ("setNoDelay" in connection && noDelay !== undefined) {
            connection.setNoDelay(noDelay)
          }
          if ("setKeepAlive" in connection && keepAlive !== undefined) {
            connection.setKeepAlive(keepAlive)
          }
        })
      )
    )
  }).pipe(
    openTimeout === undefined
      ? Function.identity
      : Effect.timeoutOrElse({
        duration: openTimeout,
        orElse: () =>
          Effect.fail(
            new Socket.SocketError({
              reason: new Socket.SocketOpenError({ kind: "Timeout", cause: new Error("Connection timed out") })
            })
          )
      })
  )
  return fromConn(acquire)
}

/**
 * Creates a channel over a native Deno TCP or Unix connection.
 *
 * @category constructors
 * @since 4.0.0
 */
export const makeTcpChannel = <IE = never>(
  options: ConnectOptions
): Channel.Channel<
  Array.NonEmptyReadonlyArray<Uint8Array>,
  Socket.SocketError | IE,
  void,
  Array.NonEmptyReadonlyArray<Uint8Array | string | Socket.CloseEvent>,
  IE
> => Channel.unwrap(Effect.map(makeTcp(options), Socket.toChannelWith<IE>()))

/**
 * Provides a socket by opening a native Deno TCP or Unix connection.
 *
 * @category layers
 * @since 4.0.0
 */
export const layerTcp: (options: ConnectOptions) => Layer.Layer<
  Socket.Socket,
  Socket.SocketError
> = Function.flow(makeTcp, Layer.effect(Socket.Socket))

/**
 * Creates a socket layer connected to a URL with Deno's global WebSocket.
 *
 * @category layers
 * @since 4.0.0
 */
export const layerWebSocket = (url: string, options?: {
  readonly closeCodeIsError?: (code: number) => boolean
}): Layer.Layer<Socket.Socket> =>
  Layer.effect(Socket.Socket, Socket.makeWebSocket(url, options)).pipe(
    Layer.provide(layerWebSocketConstructor)
  )

/**
 * Provides the WebSocket constructor backed by `globalThis.WebSocket`.
 *
 * @category layers
 * @since 4.0.0
 */
export const layerWebSocketConstructor: Layer.Layer<Socket.WebSocketConstructor> =
  Socket.layerWebSocketConstructorGlobal

const encoder = new TextEncoder()

const isBadResource = (cause: unknown): cause is Deno.errors.BadResource => cause instanceof Deno.errors.BadResource

const isTeardownError = (cause: unknown): boolean => cause instanceof Deno.errors.Interrupted || isBadResource(cause)

const close = (conn: Deno.Conn): Effect.Effect<void> =>
  Effect.try(() => conn.close()).pipe(
    Effect.catch(({ cause }) => isBadResource(cause) ? Effect.void : Effect.die(cause))
  )

const closeWrite = (conn: Deno.Conn): Effect.Effect<void> =>
  Effect.tryPromise(() => conn.closeWrite()).pipe(
    Effect.catch((error) => isBadResource(error) ? Effect.void : Effect.die(error))
  )

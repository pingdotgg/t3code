/**
 * Native Deno TCP and Unix socket servers for Effect's unstable socket server
 * API.
 *
 * The plain `make` and `layer` names intentionally differ from
 * `DenoSocket.makeTcp` and `DenoSocket.layerTcp` because this module has only
 * one server kind. Deno has no standalone WebSocket server, so WebSocket
 * constructors are omitted, and there is no `IncomingMessage` analogue.
 * Connections made before `run` starts remain in the kernel backlog instead of
 * being accepted and buffered as they are by the Node implementation. A second
 * concurrent `run` waits for the first because listener access is guarded by a
 * semaphore.
 *
 * Deno-native TLS server constructors are included even though the Node socket
 * server has no corresponding dedicated constructors. TLS is deliberately not
 * tested here because the repository has no certificate fixture.
 *
 * @since 4.0.0
 */
import * as Effect from "effect/Effect"
import * as Function from "effect/Function"
import * as Layer from "effect/Layer"
import type * as Scope from "effect/Scope"
import * as SocketServer from "effect/unstable/socket/SocketServer"
import { closeListener, fromListener } from "./internal/denoSocketServer.ts"

/**
 * Native Deno options for listening on a TCP or Unix socket.
 *
 * @category models
 * @since 4.0.0
 */
export type ListenOptions =
  | (Deno.TcpListenOptions & { transport?: "tcp" })
  | (Deno.UnixListenOptions & { transport: "unix" })

/**
 * Native Deno options and certified key material for listening with TLS.
 *
 * @category models
 * @since 4.0.0
 */
export type TlsListenOptions = Deno.ListenTlsOptions & Deno.TlsCertifiedKeyPem

/**
 * Creates a scoped socket server using a native Deno TCP or Unix listener.
 *
 * @category constructors
 * @since 4.0.0
 */
export const make: (
  options: ListenOptions
) => Effect.Effect<
  SocketServer.SocketServer["Service"],
  SocketServer.SocketServerError,
  Scope.Scope
> = Effect.fnUntraced(function*(options) {
  const listener = yield* Effect.acquireRelease(
    Effect.try({
      try: () => options.transport === "unix" ? Deno.listen(options) : Deno.listen(options),
      catch: openError
    }),
    closeListener
  )
  return fromListener(listener)
})

/**
 * Provides a socket server using a scoped native Deno TCP or Unix listener.
 *
 * @category layers
 * @since 4.0.0
 */
export const layer: (
  options: ListenOptions
) => Layer.Layer<SocketServer.SocketServer, SocketServer.SocketServerError> = Function.flow(
  make,
  Layer.effect(SocketServer.SocketServer)
)

/**
 * Creates a scoped TLS socket server using a native Deno TLS listener.
 *
 * @category constructors
 * @since 4.0.0
 */
export const makeTls: (
  options: TlsListenOptions
) => Effect.Effect<
  SocketServer.SocketServer["Service"],
  SocketServer.SocketServerError,
  Scope.Scope
> = Effect.fnUntraced(function*(options) {
  const listener = yield* Effect.acquireRelease(
    Effect.try({
      try: () => Deno.listenTls(options),
      catch: openError
    }),
    closeListener
  )
  return fromListener(listener)
})

/**
 * Provides a TLS socket server using a scoped native Deno TLS listener.
 *
 * @category layers
 * @since 4.0.0
 */
export const layerTls: (
  options: TlsListenOptions
) => Layer.Layer<SocketServer.SocketServer, SocketServer.SocketServerError> = Function.flow(
  makeTls,
  Layer.effect(SocketServer.SocketServer)
)

const openError = (cause: unknown) =>
  new SocketServer.SocketServerError({
    reason: new SocketServer.SocketServerOpenError({ cause })
  })

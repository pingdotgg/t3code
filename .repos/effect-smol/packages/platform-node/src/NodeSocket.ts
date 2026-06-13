/**
 * Node.js socket constructors and layers for Effect sockets.
 *
 * This module combines shared Node stream-backed socket support with
 * Node-specific WebSocket constructor layers. Use it to open TCP clients, Unix
 * domain socket clients, adapt existing Node `Duplex` streams, or provide
 * WebSocket clients to protocols built on Effect's `Socket.Socket`.
 *
 * **Mental model**
 *
 * TCP and Unix sockets come from `node:net` and are exposed as scoped
 * `Socket.Socket` values. Stream open, read, write, and close events are
 * translated to `SocketError` values, and finalization closes or destroys the
 * underlying stream. WebSocket layers provide only the constructor service used
 * by `Socket.makeWebSocket`; `layerWebSocket` combines that constructor with a
 * URL to provide a socket layer.
 *
 * **Common tasks**
 *
 * - Use `makeNet`, `makeNetChannel`, or `layerNet` for TCP connections.
 * - Set `NetConnectOpts.path` for Unix domain sockets.
 * - Use `fromDuplex` when another library already owns a Node `Duplex`.
 * - Use `layerWebSocketConstructor` for the native WebSocket when present, with
 *   fallback to `ws`; use `layerWebSocketConstructorWS` to force `ws`.
 *
 * **Gotchas**
 *
 * Socket lifetime is scoped, so release the layer or scope to close the
 * connection. Writes complete when Node accepts or flushes the chunk, not when
 * a peer processes it. Remote `end` events complete the socket run, while
 * abnormal closes, open timeouts, and stream errors surface through
 * `SocketError`; handle them in the Effect that runs the socket.
 *
 * @since 4.0.0
 */
import { NodeWS as WS } from "@effect/platform-node-shared/NodeSocket"
import type * as Duration from "effect/Duration"
import type * as Effect from "effect/Effect"
import { flow } from "effect/Function"
import * as Layer from "effect/Layer"
import * as Socket from "effect/unstable/socket/Socket"

/**
 * @since 4.0.0
 */
export * from "@effect/platform-node-shared/NodeSocket"

/**
 * Provides a `Socket.WebSocketConstructor`, using `globalThis.WebSocket` when
 * available and falling back to the `ws` package otherwise.
 *
 * @category layers
 * @since 4.0.0
 */
export const layerWebSocketConstructor: Layer.Layer<
  Socket.WebSocketConstructor
> = Layer.sync(Socket.WebSocketConstructor)(() => {
  if ("WebSocket" in globalThis) {
    return (url, protocols) => new globalThis.WebSocket(url, protocols)
  }
  return (url, protocols) => new WS.WebSocket(url, protocols) as unknown as globalThis.WebSocket
})

/**
 * Provides a `Socket.WebSocketConstructor` backed explicitly by the `ws`
 * package.
 *
 * @category layers
 * @since 4.0.0
 */
export const layerWebSocketConstructorWS: Layer.Layer<
  Socket.WebSocketConstructor
> = Layer.succeed(Socket.WebSocketConstructor)(
  (url, protocols) => new WS.WebSocket(url, protocols) as unknown as globalThis.WebSocket
)

/**
 * Creates a `Socket.Socket` layer for a WebSocket URL using the Node WebSocket
 * constructor layer, honoring protocol, open-timeout, and close-code error
 * options.
 *
 * @category layers
 * @since 4.0.0
 */
export const layerWebSocket: (
  url: string | Effect.Effect<string>,
  options?: {
    readonly closeCodeIsError?: ((code: number) => boolean) | undefined
    readonly openTimeout?: Duration.Input | undefined
    readonly protocols?: string | Array<string> | undefined
  } | undefined
) => Layer.Layer<Socket.Socket, never, never> = flow(
  Socket.makeWebSocket,
  Layer.effect(Socket.Socket),
  Layer.provide(layerWebSocketConstructor)
)

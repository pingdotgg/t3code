/**
 * Browser WebSocket layers for Effect sockets.
 *
 * `layerWebSocket` creates a `Socket.Socket` connected to a WebSocket URL using
 * the browser `WebSocket` constructor. `layerWebSocketConstructor` provides
 * only the browser-backed constructor service for lower-level socket code.
 *
 * @since 4.0.0
 */
import * as Layer from "effect/Layer"
import * as Socket from "effect/unstable/socket/Socket"

/**
 * Creates a `Socket` layer connected to the given URL using the browser `WebSocket` constructor.
 *
 * **When to use**
 *
 * Use when you need browser code to satisfy the platform socket service from a
 * URL without wiring the browser constructor service separately.
 *
 * **Details**
 *
 * Delegates socket construction to `Socket.makeWebSocket` and provides the
 * browser-backed `WebSocketConstructor` service.
 *
 * **Gotchas**
 *
 * Browser WebSocket rules still control URL schemes, mixed-content blocking,
 * cookies, authentication, origin checks, subprotocols, and extensions. Close
 * events are errors unless `closeCodeIsError` classifies the close code as
 * clean.
 *
 * @see {@link layerWebSocketConstructor} for providing only the browser constructor service
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
 * Layer that provides a `WebSocketConstructor` service backed by `globalThis.WebSocket`.
 *
 * @category layers
 * @since 4.0.0
 */
export const layerWebSocketConstructor: Layer.Layer<Socket.WebSocketConstructor> =
  Socket.layerWebSocketConstructorGlobal

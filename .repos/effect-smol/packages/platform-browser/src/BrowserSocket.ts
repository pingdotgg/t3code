/**
 * Provide Effect sockets backed by the browser `WebSocket` implementation.
 *
 * This module is the browser entry point for Effect's socket abstraction. Use
 * {@link layerWebSocket} when a client-side Effect program needs a complete
 * `Socket.Socket` connected to a WebSocket URL. Use
 * {@link layerWebSocketConstructor} when lower-level socket code only needs the
 * browser-backed constructor service.
 *
 * ## Mental model
 *
 * `layerWebSocket` delegates socket behavior to Effect's WebSocket support and
 * supplies `globalThis.WebSocket` as the constructor. Incoming browser messages
 * are normalized to strings or binary `Uint8Array` values. Browser `Blob`
 * messages are read into bytes before they reach the socket consumer.
 *
 * Outgoing data should already be serialized to a string or bytes. To close the
 * underlying browser socket with a specific code and reason, send a
 * `CloseEvent` value so the close metadata is preserved.
 *
 * ## Common tasks
 *
 * - Connect RPC transports, browser tests, or realtime UI features to a
 *   WebSocket URL with {@link layerWebSocket}.
 * - Provide only the browser constructor service with
 *   {@link layerWebSocketConstructor} when another socket layer builds the
 *   connection.
 * - Customize `closeCodeIsError` for protocols that treat specific close codes
 *   as normal completion instead of socket failure.
 *
 * ## Gotchas
 *
 * Browser WebSocket rules still apply. URL schemes, subprotocol negotiation,
 * mixed-content blocking, cookies, authentication, server origin checks, and
 * extension negotiation are controlled by the browser and server rather than by
 * Effect. Close events become socket errors unless `closeCodeIsError`
 * classifies the close code as clean.
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
 * Use when browser or client-side code needs a complete `Socket` layer
 * connected to a WebSocket URL.
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

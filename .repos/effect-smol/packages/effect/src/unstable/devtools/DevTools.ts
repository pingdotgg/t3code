/**
 * High-level layers for connecting an Effect runtime to the unstable devtools
 * tracer.
 *
 * `DevTools` is the application-facing entry point for installing a tracer that
 * mirrors the current tracer and streams spans, span events, span completions,
 * and metric snapshots to an external devtools process. Lower-level socket
 * protocol details live in `DevToolsClient`.
 *
 * **Common tasks**
 *
 * - Use {@link layer} when the runtime provides a global `WebSocket`
 * - Use {@link layerWebSocket} when the environment should provide the
 *   `WebSocketConstructor`
 * - Use {@link layerSocket} when an integration already has a `Socket`
 *   transport
 *
 * **Gotchas**
 *
 * - The WebSocket helpers default to `ws://localhost:34437`.
 * - These layers install only the client-side tracer; start or connect the
 *   devtools server separately.
 * - The tracer is scoped to the runtime or layer graph that receives the layer.
 * - This module is under `unstable`, so the transport protocol and exports may
 *   change between releases.
 *
 * @since 4.0.0
 */
import * as Layer from "../../Layer.ts"
import * as Socket from "../socket/Socket.ts"
import * as DevToolsClient from "./DevToolsClient.ts"

/**
 * Layer that installs the devtools tracer using an existing `Socket`.
 *
 * @category layers
 * @since 4.0.0
 */
export const layerSocket: Layer.Layer<never, never, Socket.Socket> = DevToolsClient.layerTracer

/**
 * Layer that installs the devtools tracer over a WebSocket connection to the
 * specified URL, defaulting to `ws://localhost:34437`.
 *
 * @category layers
 * @since 4.0.0
 */
export const layerWebSocket = (
  url = "ws://localhost:34437"
): Layer.Layer<never, never, Socket.WebSocketConstructor> =>
  DevToolsClient.layerTracer.pipe(
    Layer.provide(Socket.layerWebSocket(url))
  )

/**
 * Layer that installs the devtools tracer over a WebSocket connection using the
 * global WebSocket constructor, defaulting to `ws://localhost:34437`.
 *
 * **When to use**
 *
 * Use to stream Effect tracing and metrics telemetry to a devtools process when
 * the runtime environment already provides a global `WebSocket` constructor.
 *
 * **Details**
 *
 * This is a convenience wrapper around `layerWebSocket(url)` that provides
 * `Socket.layerWebSocketConstructorGlobal`, so the resulting layer has no
 * remaining requirements.
 *
 * **Gotchas**
 *
 * This layer only installs the client-side tracer; it does not start a devtools
 * server, so the configured WebSocket endpoint must already be reachable. It
 * relies on `globalThis.WebSocket` being available in the runtime.
 *
 * @see {@link layerWebSocket} for installing the devtools tracer with an explicit `WebSocketConstructor` requirement
 * @see {@link layerSocket} for installing the devtools tracer over an existing `Socket` transport
 *
 * @category layers
 * @since 4.0.0
 */
export const layer = (url = "ws://localhost:34437"): Layer.Layer<never> =>
  layerWebSocket(url).pipe(
    Layer.provide(Socket.layerWebSocketConstructorGlobal)
  )

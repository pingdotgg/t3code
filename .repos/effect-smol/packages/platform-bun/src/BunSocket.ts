/**
 * Bun platform socket entry point for Effect sockets backed by Bun-compatible
 * Node streams and Bun's native WebSocket implementation.
 *
 * This module re-exports the shared Node socket constructors for TCP clients,
 * Unix domain socket clients, and adapters from existing Node `Duplex` streams,
 * then adds Bun-specific WebSocket layers using `globalThis.WebSocket`. Use it
 * in Bun applications that connect to raw socket protocols, Unix sockets,
 * realtime WebSocket services, or Effect RPC transports that need a
 * `Socket.Socket` layer.
 *
 * TCP lifecycle behavior comes from the shared Node layer: sockets are scoped,
 * finalizers close or destroy the underlying stream, open timeouts become
 * socket open errors, and read, write, and close events are mapped to
 * `SocketError` values. TLS concerns depend on the transport being used: `wss:`
 * URLs are handled by Bun's WebSocket implementation, while TLS-wrapped
 * `Duplex` streams can be adapted after they have been created elsewhere.
 * When closing intentionally, send `Socket.CloseEvent` values so the close code
 * and reason are preserved through the socket lifecycle.
 *
 * @since 4.0.0
 */
import type * as Duration from "effect/Duration"
import type { Effect } from "effect/Effect"
import { flow } from "effect/Function"
import * as Layer from "effect/Layer"
import * as Socket from "effect/unstable/socket/Socket"

/**
 * @since 4.0.0
 */
export * from "@effect/platform-node-shared/NodeSocket"

/**
 * Provides a `Socket.WebSocketConstructor` backed by Bun's global
 * `WebSocket` implementation.
 *
 * @category layers
 * @since 4.0.0
 */
export const layerWebSocketConstructor: Layer.Layer<
  Socket.WebSocketConstructor
> = Layer.succeed(Socket.WebSocketConstructor)(
  (url, protocols) => new globalThis.WebSocket(url, protocols)
)

/**
 * Creates a `Socket.Socket` layer for a WebSocket URL using Bun's global
 * `WebSocket` constructor, honoring protocol, open-timeout, and close-code
 * error options.
 *
 * @category layers
 * @since 4.0.0
 */
export const layerWebSocket: (
  url: string | Effect<string>,
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

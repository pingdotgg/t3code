import type * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Layer from "effect/Layer";
import type * as Rpc from "effect/rpc/Rpc";
import * as RpcClient from "effect/rpc/RpcClient";
import type { RpcClientError } from "effect/rpc/RpcClientError";
import type * as RpcGroup from "effect/rpc/RpcGroup";
import * as RpcSerialization from "effect/rpc/RpcSerialization";
import * as Socket from "effect/socket/Socket";

export interface LayerOptions {
  /** Options passed to Effect's WebSocket transport. */
  readonly socket?: Parameters<typeof Socket.layerWebSocket>[1];
  /** Options passed to Effect's socket RPC protocol. */
  readonly protocol?: Parameters<typeof RpcClient.layerProtocolSocket>[0];
  /** Options passed to the grouped Effect RPC client. */
  readonly client?: Omit<NonNullable<Parameters<typeof RpcClient.make>[1]>, "flatten">;
  /**
   * Serialization matching the server. Alchemy's RpcDurableObject uses JSON.
   * @default RpcSerialization.json
   */
  readonly serialization?: RpcSerialization.RpcSerialization["Service"];
}

type ProtocolOptions = NonNullable<LayerOptions["protocol"]>;

/**
 * Effect's pinger drops the connection when no frame arrived within
 * `pingTimeout` of a ping tick, and `pingTimeout` defaults to the interval:
 * a Pong that returns faster than the timer's own drift (any local server)
 * then misses the deadline by a few milliseconds. Allow two intervals.
 */
const withPingTimeout = (protocol: LayerOptions["protocol"]): ProtocolOptions => ({
  ...protocol,
  pingTimeout:
    protocol?.pingTimeout ??
    Duration.times(Duration.fromInputUnsafe(protocol?.pingInterval ?? "5 seconds"), 2),
});

/**
 * Provide a typed RPC client and its WebSocket connection for the Layer's lifetime.
 *
 * Import from `@alchemy.run/cloudflare/Workers/RpcWebSocketClient` in browsers to avoid
 * Cloudflare server modules. Provide `Socket.layerWebSocketConstructorGlobal`
 * in a browser, or the corresponding constructor Layer for another platform.
 * RPC client middleware remains an explicit dependency.
 *
 * Provide this Layer around the application or session that shares the client.
 * Releasing the Layer closes the connection on success, failure, or interruption.
 * Ordinary calls need no caller Scope; streaming calls using `{ asQueue: true }`
 * still require a Scope for the queue consumer. Inside a Cloudflare Worker,
 * provide this Layer per request, not in the isolate-scoped initializer.
 *
 * ### Browser Client
 * **Example:** Provide a client for the application's program
 * ```typescript
 * import * as RpcWebSocketClient from "@alchemy.run/cloudflare/Workers/RpcWebSocketClient";
 * import { Context, Effect, Layer } from "effect";
 * import type * as RpcClient from "effect/rpc/RpcClient";
 * import type { RpcClientError } from "effect/rpc/RpcClientError";
 * import * as Socket from "effect/socket/Socket";
 * import { CounterRpcs } from "./rpcs.ts";
 *
 * class CounterClient extends Context.Service<
 *   CounterClient,
 *   RpcClient.FromGroup<typeof CounterRpcs, RpcClientError>
 * >()("CounterClient") {}
 *
 * const ClientLive = RpcWebSocketClient.layer(
 *   CounterClient,
 *   CounterRpcs,
 *   "wss://example.com/counters/alice",
 * ).pipe(Layer.provide(Socket.layerWebSocketConstructorGlobal));
 *
 * const program = Effect.gen(function* () {
 *   const counter = yield* CounterClient;
 *   return yield* counter.increment();
 * }).pipe(Effect.provide(ClientLive));
 * ```
 *
 * @layer
 * @provides service
 * @product Workers
 * @category Workers & Compute
 */
export const layer = <I, Rpcs extends Rpc.Any>(
  service: Context.Key<I, RpcClient.RpcClient<Rpcs, RpcClientError>>,
  group: RpcGroup.RpcGroup<Rpcs>,
  url: Parameters<typeof Socket.layerWebSocket>[0],
  options: LayerOptions = {},
): Layer.Layer<I, never, Socket.WebSocketConstructor | Rpc.MiddlewareClient<Rpcs>> =>
  Layer.effect(service, RpcClient.make(group, options.client)).pipe(
    Layer.provide(
      RpcClient.layerProtocolSocket(withPingTimeout(options.protocol)).pipe(
        Layer.provide(
          Layer.mergeAll(
            Socket.layerWebSocket(url, options.socket),
            Layer.succeed(
              RpcSerialization.RpcSerialization,
              options.serialization ?? RpcSerialization.json,
            ),
          ),
        ),
      ),
    ),
  );

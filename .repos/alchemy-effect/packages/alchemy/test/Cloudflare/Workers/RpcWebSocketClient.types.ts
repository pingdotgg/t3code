import * as RpcWebSocketClient from "alchemy/Cloudflare/RpcWebSocketClient";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as RpcClient from "effect/rpc/RpcClient";
import type { RpcClientError } from "effect/rpc/RpcClientError";
import type * as RpcGroup from "effect/rpc/RpcGroup";
import * as RpcMessage from "effect/rpc/RpcMessage";
import * as RpcMiddleware from "effect/rpc/RpcMiddleware";
import * as RpcSerialization from "effect/rpc/RpcSerialization";
import * as Socket from "effect/socket/Socket";
import { BrowserClient } from "./fixtures/rpc-websocket-client/browser.ts";
import { BrowserRpcs } from "./fixtures/rpc-websocket-client/rpcs.ts";

export const inferredLayer = RpcWebSocketClient.layer(
  BrowserClient,
  BrowserRpcs,
  "wss://example.com/rpc",
);

const constructorRequired: Layer.Layer<
  BrowserClient,
  never,
  Socket.WebSocketConstructor
> = inferredLayer;
// @ts-expect-error The browser WebSocket constructor must be supplied explicitly.
const missingConstructor: Layer.Layer<BrowserClient> = inferredLayer;

export const browserLayer = inferredLayer.pipe(
  Layer.provide(Socket.layerWebSocketConstructorGlobal),
);
const fullyProvided: Layer.Layer<BrowserClient> = browserLayer;

export const ordinaryCall = Effect.gen(function* () {
  const client = yield* BrowserClient;
  return yield* client.echo({ value: "hello" });
}).pipe(Effect.provide(browserLayer));
const ordinaryWithoutScope: Effect.Effect<string, RpcClientError | "Rejected"> =
  ordinaryCall;
// @ts-expect-error The declared RPC error remains in the caller's error channel.
const missingRpcError: Effect.Effect<string, RpcClientError> = ordinaryCall;

export const streamingCall = Effect.gen(function* () {
  const client = yield* BrowserClient;
  return yield* client.numbers({ count: 3 }).pipe(Stream.runCollect);
}).pipe(Effect.provide(browserLayer));
const streamWithoutScope: Effect.Effect<
  ReadonlyArray<number>,
  RpcClientError
> = streamingCall;

export const queueCall = Effect.gen(function* () {
  const client = yield* BrowserClient;
  return yield* client.numbers({ count: 3 }, { asQueue: true });
}).pipe(Effect.provide(browserLayer));
const queueWithScope: Effect.Effect<unknown, never, Scope.Scope> = queueCall;
// @ts-expect-error A queue consumer still owns its Scope after the client is provided.
const queueWithoutScope: Effect.Effect<unknown> = queueCall;

export class ClientMiddleware extends RpcMiddleware.Service<ClientMiddleware>()(
  "RpcWebSocketClientMiddleware",
  { requiredForClient: true },
) {}

export const MiddlewareRpcs = BrowserRpcs.middleware(ClientMiddleware);
export class MiddlewareClient extends Context.Service<MiddlewareClient>()(
  "RpcWebSocketMiddlewareClient",
  { make: RpcClient.make(MiddlewareRpcs) },
) {}

export const middlewareLayer = RpcWebSocketClient.layer(
  MiddlewareClient,
  MiddlewareRpcs,
  "wss://example.com/rpc",
);
const middlewareRequired: Layer.Layer<
  MiddlewareClient,
  never,
  Socket.WebSocketConstructor | RpcMiddleware.ForClient<ClientMiddleware>
> = middlewareLayer;
// @ts-expect-error Supplying the constructor does not supply client middleware.
const missingMiddleware: Layer.Layer<
  MiddlewareClient,
  never,
  Socket.WebSocketConstructor
> = middlewareLayer;
// @ts-expect-error Supplying client middleware does not supply the constructor.
const middlewareMissingConstructor: Layer.Layer<
  MiddlewareClient,
  never,
  RpcMiddleware.ForClient<ClientMiddleware>
> = middlewareLayer;

export const middlewareCall = Effect.gen(function* () {
  const client = yield* MiddlewareClient;
  return yield* client.echo({ value: "authorized" });
}).pipe(
  Effect.provide(
    middlewareLayer.pipe(Layer.provide(Socket.layerWebSocketConstructorGlobal)),
  ),
);
const callRequiresMiddleware: Effect.Effect<
  string,
  RpcClientError | "Rejected",
  RpcMiddleware.ForClient<ClientMiddleware>
> = middlewareCall;
// @ts-expect-error Client middleware remains required when the layer is provided.
const callMissingMiddleware: Effect.Effect<
  string,
  RpcClientError | "Rejected"
> = middlewareCall;

export const authorizedCall = middlewareCall.pipe(
  Effect.provide(
    RpcMiddleware.layerClient(ClientMiddleware, ({ request, next }) =>
      next(request),
    ),
  ),
);
const authorizedWithoutScope: Effect.Effect<
  string,
  RpcClientError | "Rejected"
> = authorizedCall;

export const options = {
  socket: {
    openTimeout: "5 seconds",
    protocols: ["rpc"],
    highWaterMark: 64 * 1024,
  },
  protocol: {
    retryTransientErrors: true,
    onTransientError: (error: RpcClientError) => Effect.logDebug(error),
  },
  client: {
    spanPrefix: "browser-rpc",
    spanAttributes: { transport: "websocket" },
    generateRequestId: () => RpcMessage.RequestId("1"),
    disableTracing: true,
  },
  serialization: RpcSerialization.ndjson,
} satisfies RpcWebSocketClient.LayerOptions;

export const configuredLayer = RpcWebSocketClient.layer(
  BrowserClient,
  BrowserRpcs,
  Effect.succeed("wss://example.com/rpc"),
  options,
);

export class ExplicitClient extends Context.Service<
  ExplicitClient,
  RpcClient.RpcClient<RpcGroup.Rpcs<typeof BrowserRpcs>, RpcClientError>
>()("ExplicitRpcWebSocketClient") {}

export const explicitLayer = RpcWebSocketClient.layer(
  ExplicitClient,
  BrowserRpcs,
  "wss://example.com/rpc",
);

export class FlatClient extends Context.Service<FlatClient>()(
  "FlatRpcWebSocketClient",
  { make: RpcClient.make(BrowserRpcs, { flatten: true }) },
) {}
// @ts-expect-error The helper exposes grouped methods, not a flattened callable client.
RpcWebSocketClient.layer(FlatClient, BrowserRpcs, "wss://example.com/rpc");
RpcWebSocketClient.layer(BrowserClient, BrowserRpcs, "wss://example.com/rpc", {
  // @ts-expect-error Flattening would change the grouped service's shape.
  client: { flatten: true },
});
RpcWebSocketClient.layer(BrowserClient, BrowserRpcs, "wss://example.com/rpc", {
  // @ts-expect-error Socket options retain the underlying Effect option types.
  socket: { protocols: 123 },
});
RpcWebSocketClient.layer(BrowserClient, BrowserRpcs, "wss://example.com/rpc", {
  // @ts-expect-error Serialization accepts a codec service, not a Layer.
  serialization: RpcSerialization.layerJson,
});

void [
  constructorRequired,
  missingConstructor,
  fullyProvided,
  ordinaryWithoutScope,
  missingRpcError,
  streamWithoutScope,
  queueWithScope,
  queueWithoutScope,
  middlewareRequired,
  missingMiddleware,
  middlewareMissingConstructor,
  callRequiresMiddleware,
  callMissingMiddleware,
  authorizedWithoutScope,
];

import { WS_METHODS } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpRouter, HttpServerRequest } from "effect/http";
import * as RpcMiddleware from "effect/rpc/RpcMiddleware";

import * as ServerRuntimeStartup from "./serverRuntimeStartup.ts";

const connectionHttpRoutes: ReadonlySet<string> = new Set([
  "GET /.well-known/t3/environment",
  "GET /api/auth/session",
  "POST /api/auth/browser-session",
  "POST /oauth/token",
  "POST /api/auth/websocket-ticket",
  "POST /api/auth/websocket-ticket/rpc",
  "POST /api/t3-connect/health",
  "POST /api/t3-connect/mint-credential",
  "POST /api/connect/mint-credential",
  "GET /ws",
]);

export const layerHttp = HttpRouter.middleware(
  Effect.gen(function* () {
    const startup = yield* ServerRuntimeStartup.ServerRuntimeStartup;
    return (httpEffect) =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const route = `${request.method} ${request.url.split("?", 1)[0]}`;
        yield* (
          connectionHttpRoutes.has(route) ? startup.awaitConnectionReady : startup.awaitCommandReady
        ).pipe(Effect.orDie);
        return yield* httpEffect;
      });
  }),
  { global: true },
);

const connectionRpcMethods: ReadonlySet<string> = new Set([
  WS_METHODS.serverProbe,
  WS_METHODS.serverGetConfig,
  WS_METHODS.subscribeServerConfig,
  WS_METHODS.subscribeServerLifecycle,
]);

export class RpcCommandReadiness extends RpcMiddleware.Service<RpcCommandReadiness>()(
  "t3/server/RpcCommandReadiness",
) {}

export const layerRpc = Layer.effect(
  RpcCommandReadiness,
  Effect.gen(function* () {
    const startup = yield* ServerRuntimeStartup.ServerRuntimeStartup;
    return RpcCommandReadiness.of((effect, { rpc }) =>
      connectionRpcMethods.has(rpc._tag)
        ? effect
        : startup.awaitCommandReady.pipe(Effect.orDie, Effect.andThen(effect)),
    );
  }),
);

import * as ApiGatewayV2 from "@/AWS/ApiGatewayV2";
import * as Lambda from "@/AWS/Lambda";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import path from "pathe";

const main = path.resolve(import.meta.dirname, "ws-handler.ts");

export class WebSocketTestFunction extends Lambda.Function<Lambda.Function>()(
  "WebSocketTestFunction",
) {}

export class WsApiAndStage extends Context.Service<
  WsApiAndStage,
  {
    api: ApiGatewayV2.Api;
    stage: ApiGatewayV2.ApiGatewayV2Stage;
  }
>()("WsApiAndStage") {}

export const WsApiAndStageLive = Layer.effect(
  WsApiAndStage,
  Effect.gen(function* () {
    const api = yield* ApiGatewayV2.Api("WsTestApi", {
      protocolType: "WEBSOCKET",
      routeSelectionExpression: "$request.body.action",
    });
    const stage = yield* ApiGatewayV2.Stage("WsTestStage", {
      api,
      stageName: "test",
      autoDeploy: true,
    });
    return { api, stage };
  }),
);

/**
 * Fixture Lambda for the WebSocket e2e test:
 *
 * - `$connect`    → accept the connection
 * - `$disconnect` → no-op
 * - `$default`    → echo the received frame back to the sender via the
 *                   ManageConnections binding (`postToConnection`)
 *
 * The function URL exposes the stage's `wss://` URL so the test can
 * discover it after deploy.
 */
export default WebSocketTestFunction.make(
  {
    main,
    url: true,
    timeout: Duration.seconds(30),
  },
  Effect.gen(function* () {
    const { api, stage } = yield* WsApiAndStage;
    const connections = yield* ApiGatewayV2.ManageConnections(stage);
    const WsUrl = yield* stage.invokeUrl;
    const CallbackUrl = yield* stage.callbackUrl;

    yield* ApiGatewayV2.onWebSocketRoute(api, { routeKey: "$connect" }, () =>
      Effect.succeed({ statusCode: 200 }),
    );

    yield* ApiGatewayV2.onWebSocketRoute(
      api,
      { routeKey: "$disconnect" },
      () => Effect.void,
    );

    yield* ApiGatewayV2.onWebSocketRoute(
      api,
      { routeKey: "$default" },
      (event) =>
        connections
          .postToConnection({
            ConnectionId: event.requestContext.connectionId,
            Data: `echo:${event.body ?? ""}`,
          })
          .pipe(
            Effect.asVoid,
            // The peer may disconnect between send and receive — not a
            // failure for the echo fixture.
            Effect.catchTag("GoneException", () => Effect.void),
            Effect.orDie,
          ),
    );

    return {
      fetch: Effect.gen(function* () {
        return yield* HttpServerResponse.json({
          wsUrl: yield* WsUrl,
          callbackUrl: yield* CallbackUrl,
        });
      }).pipe(Effect.orDie),
    };
  }).pipe(
    Effect.provide(
      Layer.provideMerge(
        Layer.mergeAll(
          Lambda.WebSocketEventSource,
          ApiGatewayV2.ManageConnectionsHttp,
        ),
        WsApiAndStageLive,
      ),
    ),
  ),
);

import type * as lambda from "aws-lambda";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type { Api } from "./Api.ts";

/**
 * The event shape a WebSocket route handler receives — the API Gateway v2
 * WebSocket proxy event (`requestContext.connectionId`, `routeKey`,
 * `eventType`, plus `body` for `MESSAGE` events).
 */
export type WebSocketEvent = lambda.APIGatewayProxyWebsocketEventV2;

/**
 * The result a WebSocket route handler may return. For `$connect` routes a
 * non-2xx `statusCode` rejects the connection; for other routes the result
 * is only surfaced to the client when the route has a route response
 * configured. Returning `void` means `{ statusCode: 200 }`.
 */
export type WebSocketResult =
  | { statusCode: number; body?: string }
  | undefined
  | void;

export interface WebSocketRouteProps {
  /**
   * The WebSocket route key this handler serves: `$connect`,
   * `$disconnect`, `$default`, or a custom action name matched by the
   * API's route selection expression.
   */
  routeKey: string;
}

export type WebSocketEventSourceService = <Req = never>(
  api: Api,
  props: WebSocketRouteProps,
  handler: (
    event: WebSocketEvent,
  ) => Effect.Effect<WebSocketResult, never, Req>,
) => Effect.Effect<void, never, never>;

/**
 * Event source connecting a WebSocket {@link Api} route to the hosting
 * Lambda function.
 *
 * At deploy time the Lambda implementation (`Lambda.WebSocketEventSource`)
 * materializes the `Integration`, `Route`, and invoke `Permission` for the
 * route; at runtime it dispatches matching WebSocket proxy events to the
 * handler. Subscribe routes with {@link onWebSocketRoute} and provide
 * `Lambda.WebSocketEventSource` on the hosting function.
 *
 * @binding
 * @section Handling WebSocket Routes
 * @example Echo server on a WEBSOCKET Api
 * ```typescript
 * export default MyFunction.make(
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const api = yield* ApiGatewayV2.Api("WsApi", {
 *       protocolType: "WEBSOCKET",
 *       routeSelectionExpression: "$request.body.action",
 *     });
 *     const stage = yield* ApiGatewayV2.Stage("WsStage", {
 *       api,
 *       stageName: "prod",
 *       autoDeploy: true,
 *     });
 *     const connections = yield* ApiGatewayV2.ManageConnections(stage);
 *
 *     yield* ApiGatewayV2.onWebSocketRoute(api, { routeKey: "$connect" }, () =>
 *       Effect.succeed({ statusCode: 200 }),
 *     );
 *
 *     yield* ApiGatewayV2.onWebSocketRoute(api, { routeKey: "$default" }, (event) =>
 *       connections
 *         .postToConnection({
 *           ConnectionId: event.requestContext.connectionId,
 *           Data: `echo:${event.body ?? ""}`,
 *         })
 *         .pipe(
 *           Effect.asVoid,
 *           Effect.catchTag("GoneException", () => Effect.void),
 *           Effect.orDie,
 *         ),
 *     );
 *
 *     return {};
 *   }).pipe(
 *     Effect.provide(
 *       Layer.mergeAll(
 *         Lambda.WebSocketEventSource,
 *         ApiGatewayV2.ManageConnectionsHttp,
 *       ),
 *     ),
 *   ),
 * );
 * ```
 */
export class WebSocketEventSource extends Context.Service<
  WebSocketEventSource,
  WebSocketEventSourceService
>()("AWS.ApiGatewayV2.WebSocketEventSource") {}

/**
 * Subscribe an Effect handler to a WebSocket route of an API Gateway v2
 * WEBSOCKET {@link Api}.
 *
 * Provide `Lambda.WebSocketEventSource` on the hosting function to
 * satisfy the requirement.
 *
 * @param api The WebSocket API.
 * @param props The route key to serve.
 * @param handler Invoked once per WebSocket event for the route.
 *
 * @example
 * ```typescript
 * yield* ApiGatewayV2.onWebSocketRoute(api, { routeKey: "$connect" }, () =>
 *   Effect.succeed({ statusCode: 200 }),
 * );
 * ```
 */
export function onWebSocketRoute<Req = never>(
  api: Api,
  props: WebSocketRouteProps,
  handler: (
    event: WebSocketEvent,
  ) => Effect.Effect<WebSocketResult, never, Req>,
): Effect.Effect<void, never, WebSocketEventSource> {
  return WebSocketEventSource.use((source) => source(api, props, handler));
}

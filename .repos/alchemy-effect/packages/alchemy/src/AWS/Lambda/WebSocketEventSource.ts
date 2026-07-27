import type lambda from "aws-lambda";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as Namespace from "../../Namespace.ts";
import * as Output from "../../Output.ts";
import type { Api } from "../ApiGatewayV2/Api.ts";
import { IntegrationResource } from "../ApiGatewayV2/Integration.ts";
import { RouteResource } from "../ApiGatewayV2/Route.ts";
import {
  WebSocketEventSource as AGW2WebSocketEventSource,
  type WebSocketEvent,
  type WebSocketEventSourceService,
  type WebSocketResult,
  type WebSocketRouteProps,
} from "../ApiGatewayV2/WebSocketEventSource.ts";
import * as Lambda from "./Function.ts";
import { Permission as LambdaPermission } from "./Permission.ts";

export const isWebSocketEvent = (
  event: any,
): event is lambda.APIGatewayProxyWebsocketEventV2 =>
  typeof event?.requestContext?.connectionId === "string" &&
  typeof event?.requestContext?.routeKey === "string" &&
  event?.requestContext?.messageDirection === "IN";

/** `$connect` → `connect` for stable, readable logical ids. */
const sanitizeRouteKey = (routeKey: string) =>
  routeKey.replace(/[^A-Za-z0-9]+/g, "") || "route";

/**
 * Connects a WebSocket API route to the current Lambda function.
 *
 * At deploy time this layer materializes the `AWS_PROXY` Integration, the
 * Route, and the API Gateway invoke Permission for each registered route
 * key; at runtime it dispatches matching WebSocket proxy events to the
 * registered handler.
 * @binding
 * @section Handling WebSocket routes
 * @example Echo server
 * ```typescript
 * const connections = yield* AWS.ApiGatewayV2.ManageConnections(stage);
 *
 * yield* AWS.ApiGatewayV2.onWebSocketRoute(api, { routeKey: "$connect" }, () =>
 *   Effect.succeed({ statusCode: 200 }),
 * );
 * yield* AWS.ApiGatewayV2.onWebSocketRoute(api, { routeKey: "$default" }, (event) =>
 *   connections
 *     .postToConnection({
 *       ConnectionId: event.requestContext.connectionId,
 *       Data: `echo:${event.body ?? ""}`,
 *     })
 *     .pipe(
 *       Effect.asVoid,
 *       Effect.catchTag("GoneException", () => Effect.void),
 *       Effect.orDie,
 *     ),
 * );
 * ```
 */
export const WebSocketEventSource = Layer.effect(
  AGW2WebSocketEventSource,
  Effect.gen(function* () {
    // this layer can only be used in a Lambda Function
    const host = yield* Lambda.Function;
    const Integration = yield* IntegrationResource;
    const Route = yield* RouteResource;
    const Permission = yield* LambdaPermission;

    return Effect.fn(function* <Req = never>(
      api: Api,
      props: WebSocketRouteProps,
      handler: (
        event: WebSocketEvent,
      ) => Effect.Effect<WebSocketResult, never, Req>,
    ) {
      // Deploy-time: materialize the Integration + Route + invoke
      // Permission for this route key. Skipped once running inside the
      // deployed Function (the global guard), where the only work is
      // registering the runtime dispatcher below. Namespaced under the
      // host for stable logical identity.
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        yield* Namespace.push(
          host.LogicalId,
          Effect.gen(function* () {
            const key = sanitizeRouteKey(props.routeKey);

            const integration = yield* Integration(
              `${api.LogicalId}-${key}-Integration`,
              {
                apiId: api.apiId,
                integrationType: "AWS_PROXY",
                // WebSocket AWS_PROXY integrations require the full Lambda
                // invocation URI. Region is derived from the function ARN
                // so the binding needs no ambient environment.
                integrationUri: Output.map(
                  host.functionArn,
                  (arn: string) =>
                    `arn:aws:apigateway:${arn.split(":")[3]}:lambda:path/2015-03-31/functions/${arn}/invocations`,
                ),
                integrationMethod: "POST",
              },
            );

            yield* Route(`${api.LogicalId}-${key}-Route`, {
              apiId: api.apiId,
              routeKey: props.routeKey,
              target: Output.map(
                integration.integrationId,
                (id: string) => `integrations/${id}`,
              ),
            });

            yield* Permission(`${api.LogicalId}-${key}-Permission`, {
              action: "lambda:InvokeFunction",
              functionName: host.functionName,
              principal: "apigateway.amazonaws.com",
              sourceArn: Output.map(
                Output.all(host.functionArn, api.apiId),
                ([fnArn, apiId]: [string, string]) => {
                  const [, , , region, accountId] = fnArn.split(":");
                  return `arn:aws:execute-api:${region}:${accountId}:${apiId}/*`;
                },
              ),
            });
          }),
        );
      }

      yield* host.listen(
        Effect.gen(function* () {
          return (event: any) => {
            if (
              isWebSocketEvent(event) &&
              event.requestContext.routeKey === props.routeKey
            ) {
              return handler(event).pipe(
                Effect.map((result) => result ?? { statusCode: 200 }),
                Effect.orDie,
              );
            }
          };
        }),
      );
    }) as WebSocketEventSourceService;
  }),
);

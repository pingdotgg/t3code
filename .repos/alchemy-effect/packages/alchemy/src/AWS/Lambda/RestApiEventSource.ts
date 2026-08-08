import type lambda from "aws-lambda";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import type { Input } from "../../Input.ts";
import * as Namespace from "../../Namespace.ts";
import * as Output from "../../Output.ts";
import {
  type ApiGatewayResource,
  GatewayResource,
} from "../ApiGateway/GatewayResource.ts";
import { MethodResource } from "../ApiGateway/Method.ts";
import type { RestApi } from "../ApiGateway/RestApi.ts";
import {
  RestApiEventSource as AGRestApiEventSource,
  type RestApiEvent,
  type RestApiEventSourceService,
  type RestApiResult,
  type RestApiRouteProps,
} from "../ApiGateway/RestApiEventSource.ts";
import * as Lambda from "./Function.ts";
import { Permission as LambdaPermission } from "./Permission.ts";

export const isRestApiEvent = (
  event: any,
): event is lambda.APIGatewayProxyEvent =>
  typeof event?.httpMethod === "string" &&
  typeof event?.resource === "string" &&
  typeof event?.requestContext?.apiId === "string" &&
  // WebSocket proxy events carry `messageDirection`; REST v1 events don't.
  event?.requestContext?.messageDirection === undefined;

/** `/items/{proxy+}` → `itemsproxy` for stable, readable logical ids. */
const sanitizePathKey = (path: string, httpMethod: string) =>
  `${path}-${httpMethod}`.replace(/[^A-Za-z0-9]+/g, "") || "root";

/**
 * Connects a REST API (v1) route to the current Lambda function.
 *
 * At deploy time this layer materializes the path `Resource` chain, the
 * `Method` with an `AWS_PROXY` integration, and the API Gateway invoke
 * `Permission` for each registered route — and registers each child as a
 * `RestApiBinding` on the API so any `Deployment` of the same API is
 * ordered after them. At runtime it dispatches matching REST proxy events
 * to the registered handler.
 * @binding
 * @section Handling REST API routes
 * @example JSON endpoint
 * ```typescript
 * yield* AWS.ApiGateway.onRestApiRoute(
 *   api,
 *   { path: "/items", httpMethod: "GET" },
 *   () =>
 *     Effect.succeed({
 *       statusCode: 200,
 *       body: JSON.stringify({ items: [] }),
 *     }),
 * );
 * ```
 */
export const RestApiEventSource = Layer.effect(
  AGRestApiEventSource,
  Effect.gen(function* () {
    // this layer can only be used in a Lambda Function
    const host = yield* Lambda.Function;
    const Resource = yield* GatewayResource;
    const Method = yield* MethodResource;
    const Permission = yield* LambdaPermission;

    return Effect.fn(function* <Req = never>(
      api: RestApi,
      props: RestApiRouteProps,
      handler: (
        event: RestApiEvent,
      ) => Effect.Effect<RestApiResult, never, Req>,
    ) {
      const path = props.path ?? "/";
      const httpMethod = (props.httpMethod ?? "ANY").toUpperCase();

      // Deploy-time: materialize the path Resource chain + Method +
      // invoke Permission for this route. Skipped once running inside
      // the deployed Function (the global guard), where the only work is
      // registering the runtime dispatcher below. Namespaced under the
      // host for stable logical identity.
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        yield* Namespace.push(
          host.LogicalId,
          Effect.gen(function* () {
            const key = sanitizePathKey(path, httpMethod);

            // Build the Resource chain for each path segment; methods on
            // the root path attach directly to `api.rootResourceId`.
            let parentId: Input<string> = api.rootResourceId;
            let prefix = "";
            for (const segment of path.split("/").filter(Boolean)) {
              prefix += `/${segment}`;
              const resourceKey =
                prefix.replace(/[^A-Za-z0-9]+/g, "") || "root";
              // Explicit annotation: `resource` feeds `parentId` for the next
              // loop iteration's `Resource(...)` call, which TS 7 otherwise
              // flags as a self-referential inference cycle (TS7022).
              const resource: ApiGatewayResource = yield* Resource(
                `${api.LogicalId}-${resourceKey}-Resource`,
                {
                  restApiId: api.restApiId,
                  parentId,
                  pathPart: segment,
                },
              );
              yield* api.bind`${resource}`({
                kind: "resource",
                resourceId: resource.resourceId,
                parentId: resource.parentId,
                pathPart: resource.pathPart,
              });
              parentId = resource.resourceId;
            }

            const method = yield* Method(`${api.LogicalId}-${key}-Method`, {
              restApiId: api.restApiId,
              resourceId: parentId,
              httpMethod,
              authorizationType: "NONE",
              integration: {
                type: "AWS_PROXY",
                integrationHttpMethod: "POST",
                // AWS_PROXY integrations require the full Lambda invocation
                // URI. Region is derived from the function ARN so the
                // binding needs no ambient environment.
                uri: Output.map(
                  host.functionArn,
                  (arn: string) =>
                    `arn:aws:apigateway:${arn.split(":")[3]}:lambda:path/2015-03-31/functions/${arn}/invocations`,
                ),
              },
            });
            yield* api.bind`${method}`({
              kind: "method",
              methodId: method.LogicalId,
              restApiId: method.restApiId,
              resourceId: method.resourceId,
              httpMethod: method.httpMethod,
            });

            yield* Permission(`${api.LogicalId}-${key}-Permission`, {
              action: "lambda:InvokeFunction",
              functionName: host.functionName,
              principal: "apigateway.amazonaws.com",
              sourceArn: Output.map(
                Output.all(host.functionArn, api.restApiId),
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
              isRestApiEvent(event) &&
              event.resource === path &&
              (httpMethod === "ANY" || event.httpMethod === httpMethod)
            ) {
              return handler(event).pipe(
                Effect.map((result) => result ?? { statusCode: 200, body: "" }),
                Effect.orDie,
              );
            }
          };
        }),
      );
    }) as RestApiEventSourceService;
  }),
);

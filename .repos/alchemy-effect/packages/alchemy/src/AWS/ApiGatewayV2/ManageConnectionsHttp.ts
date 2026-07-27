import { Endpoint } from "@distilled.cloud/aws";
import * as mgmt from "@distilled.cloud/aws/apigatewaymanagementapi";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Binding from "../../Binding.ts";
import { isBindingHost } from "../Lambda/Function.ts";
import {
  ManageConnections,
  type DeleteConnectionRequest,
  type GetConnectionRequest,
  type PostToConnectionRequest,
} from "./ManageConnections.ts";
import type { ApiGatewayV2Stage } from "./Stage.ts";

/**
 * HTTP implementation of the {@link ManageConnections} binding. Signs
 * `@connections` requests with the Lambda's IAM role against the stage's
 * callback endpoint.
 *
 * Provide it on the hosting Lambda function's Effect so the binding is
 * available at runtime:
 *
 * @example
 * ```typescript
 * export default MyFunction.make(
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const connections = yield* ApiGatewayV2.ManageConnections(stage);
 *     // ... register WebSocket routes that push via `connections`
 *     return {};
 *   }).pipe(Effect.provide(ApiGatewayV2.ManageConnectionsHttp)),
 * );
 * ```
 */
export const ManageConnectionsHttp = Layer.effect(
  ManageConnections,
  Effect.gen(function* () {
    const postToConnection = yield* mgmt.postToConnection;
    const getConnection = yield* mgmt.getConnection;
    const deleteConnection = yield* mgmt.deleteConnection;

    return Effect.fn(function* <S extends ApiGatewayV2Stage>(stage: S) {
      const CallbackUrl = yield* stage.callbackUrl;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isBindingHost(host)) {
          yield* host.bind`Allow(${host}, AWS.ApiGatewayV2.ManageConnections(${stage}))`(
            {
              policyStatements: [
                {
                  Effect: "Allow",
                  Action: ["execute-api:ManageConnections"],
                  Resource: [stage.connectionsArn],
                },
              ],
            },
          );
        }
      }

      // The management API is served from the stage's own callback
      // endpoint rather than the service default, so each call overrides
      // the distilled endpoint resolver with the bound URL.
      const withEndpoint = <A, E>(
        effect: Effect.Effect<A, E>,
        endpoint: string,
      ): Effect.Effect<A, E> =>
        Effect.provideService(
          effect,
          Endpoint.Endpoint,
          Effect.succeed(endpoint),
        );

      return {
        postToConnection: Effect.fn(
          `AWS.ApiGatewayV2.PostToConnection(${stage.LogicalId})`,
        )(function* (request: PostToConnectionRequest) {
          const endpoint = yield* CallbackUrl;
          return yield* withEndpoint(postToConnection(request), endpoint);
        }),
        getConnection: Effect.fn(
          `AWS.ApiGatewayV2.GetConnection(${stage.LogicalId})`,
        )(function* (request: GetConnectionRequest) {
          const endpoint = yield* CallbackUrl;
          return yield* withEndpoint(getConnection(request), endpoint);
        }),
        deleteConnection: Effect.fn(
          `AWS.ApiGatewayV2.DeleteConnection(${stage.LogicalId})`,
        )(function* (request: DeleteConnectionRequest) {
          const endpoint = yield* CallbackUrl;
          return yield* withEndpoint(deleteConnection(request), endpoint);
        }),
      };
    });
  }),
);

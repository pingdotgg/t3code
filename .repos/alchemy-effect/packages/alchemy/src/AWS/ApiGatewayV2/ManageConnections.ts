import type * as mgmt from "@distilled.cloud/aws/apigatewaymanagementapi";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { ApiGatewayV2Stage } from "./Stage.ts";

export interface PostToConnectionRequest extends mgmt.PostToConnectionRequest {}
export interface GetConnectionRequest extends mgmt.GetConnectionRequest {}
export interface DeleteConnectionRequest extends mgmt.DeleteConnectionRequest {}

/**
 * The runtime client returned by binding {@link ManageConnections} to a
 * WebSocket API stage.
 */
export interface ManageConnectionsClient {
  /**
   * Send data to a connected WebSocket client. Fails with a typed
   * `GoneException` when the connection has already disconnected (410).
   */
  readonly postToConnection: (
    request: PostToConnectionRequest,
  ) => Effect.Effect<mgmt.PostToConnectionResponse, mgmt.PostToConnectionError>;
  /**
   * Get metadata (connect time, last active time, source identity) about a
   * connection.
   */
  readonly getConnection: (
    request: GetConnectionRequest,
  ) => Effect.Effect<mgmt.GetConnectionResponse, mgmt.GetConnectionError>;
  /**
   * Forcibly disconnect a WebSocket client.
   */
  readonly deleteConnection: (
    request: DeleteConnectionRequest,
  ) => Effect.Effect<mgmt.DeleteConnectionResponse, mgmt.DeleteConnectionError>;
}

/**
 * Runtime binding for the WebSocket `@connections` management API
 * (`execute-api:ManageConnections`).
 *
 * Bind this to a WebSocket API {@link Stage} inside a function runtime to
 * push messages to connected clients — the flagship server-push primitive
 * for WebSocket APIs. The binding grants `execute-api:ManageConnections`
 * scoped to the stage's `@connections` ARN and targets the stage's
 * callback endpoint (`https://{apiId}.execute-api.{region}.amazonaws.com/{stage}`).
 *
 * Provide `ApiGatewayV2.ManageConnectionsHttp` on the hosting function's
 * Effect (`Effect.provide(ApiGatewayV2.ManageConnectionsHttp)`) to satisfy
 * the binding.
 * @binding
 * @section Pushing to clients
 * @example Echo a message back to the sender
 * ```typescript
 * const connections = yield* ApiGatewayV2.ManageConnections(stage);
 *
 * yield* ApiGatewayV2.onWebSocketRoute(api, { routeKey: "$default" }, (event) =>
 *   connections
 *     .postToConnection({
 *       ConnectionId: event.requestContext.connectionId,
 *       Data: `echo:${event.body ?? ""}`,
 *     })
 *     .pipe(
 *       Effect.asVoid,
 *       // The peer may have disconnected between send and receive.
 *       Effect.catchTag("GoneException", () => Effect.void),
 *       Effect.orDie,
 *     ),
 * );
 * ```
 *
 * @section Managing connections
 * @example Disconnect a client
 * ```typescript
 * yield* connections.deleteConnection({ ConnectionId: staleConnectionId });
 * ```
 */
export interface ManageConnections extends Binding.Service<
  ManageConnections,
  "AWS.ApiGatewayV2.ManageConnections",
  <S extends ApiGatewayV2Stage>(
    stage: S,
  ) => Effect.Effect<ManageConnectionsClient>
> {}
export const ManageConnections = Binding.Service<ManageConnections>(
  "AWS.ApiGatewayV2.ManageConnections",
);

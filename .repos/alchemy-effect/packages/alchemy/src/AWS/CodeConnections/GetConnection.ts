import type * as codeconnections from "@distilled.cloud/aws/codeconnections";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Connection } from "./Connection.ts";

/**
 * Runtime binding for `codeconnections:GetConnection`.
 *
 * Bind this operation to a {@link Connection} to read the connection's live
 * state — status (`PENDING`/`AVAILABLE`/`ERROR`), provider type, and owner —
 * from inside a function runtime. Useful for workloads that gate work on the
 * connection's OAuth handshake having been completed. Provide the
 * implementation with `Effect.provide(AWS.CodeConnections.GetConnectionHttp)`.
 * @binding
 * @section Inspecting a Connection
 * @example Gate on the Connection Being AVAILABLE
 * ```typescript
 * // init — bind the operation to the connection
 * const getConnection = yield* AWS.CodeConnections.GetConnection(connection);
 *
 * // runtime
 * const { Connection: live } = yield* getConnection();
 * if (live?.ConnectionStatus !== "AVAILABLE") {
 *   return yield* HttpServerResponse.text("handshake pending", { status: 409 });
 * }
 * ```
 */
export interface GetConnection extends Binding.Service<
  GetConnection,
  "AWS.CodeConnections.GetConnection",
  (
    connection: Connection,
  ) => Effect.Effect<
    () => Effect.Effect<
      codeconnections.GetConnectionOutput,
      codeconnections.GetConnectionError
    >
  >
> {}

export const GetConnection = Binding.Service<GetConnection>(
  "AWS.CodeConnections.GetConnection",
);

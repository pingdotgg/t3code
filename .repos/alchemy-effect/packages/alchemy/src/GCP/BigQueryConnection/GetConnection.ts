import type * as bigqueryconnection from "@distilled.cloud/gcp/bigqueryconnection_v1";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { RuntimeContext } from "../../RuntimeContext.ts";
import type { Connection } from "./Connection.ts";

export interface GetConnectionRequest extends Omit<
  bigqueryconnection.GetProjectsLocationsConnectionsRequest,
  "name"
> {}

/**
 * Runtime binding for BigQuery Connection `connections.get`.
 *
 * Bind this operation to a {@link Connection} in a Function/Action init
 * phase. Provide {@link GetConnectionHttp}.
 *
 * ### Reading a Connection
 * **Example:** Get the bound connection
 * ```typescript
 * const getConnection = yield* GCP.BigQueryConnection.GetConnection(gcs);
 * const live = yield* getConnection();
 * ```
 *
 * @binding
 * @category BigQueryConnection
 */
export interface GetConnection extends Binding.Service<
  GetConnection,
  "GCP.BigQueryConnection.GetConnection",
  (
    connection: Connection,
  ) => Effect.Effect<
    (
      request?: GetConnectionRequest,
    ) => Effect.Effect<
      bigqueryconnection.Connection,
      bigqueryconnection.GetProjectsLocationsConnectionsError,
      RuntimeContext
    >
  >
> {}

export const GetConnection = Binding.Service<GetConnection>(
  "GCP.BigQueryConnection.GetConnection",
);

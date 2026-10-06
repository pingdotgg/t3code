import type * as oracle from "@distilled.cloud/gcp/oracledatabase_v1";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { RuntimeContext } from "../../RuntimeContext.ts";
import type { GoldengateConnection } from "./GoldengateConnection.ts";

export interface GetGoldengateConnectionRequest extends Omit<
  oracle.GetProjectsLocationsGoldengateConnectionsRequest,
  "name"
> {}

/**
 * Runtime binding for Oracle Database `goldengateConnections.get`.
 *
 * ### Observing GoldenGate connections
 * **Example:** Read the bound connection
 * ```typescript
 * const get = yield* GCP.OracleDatabase.GetGoldengateConnection(conn);
 * const live = yield* get();
 * ```
 *
 * @binding
 * @category OracleDatabase
 */
export interface GetGoldengateConnection extends Binding.Service<
  GetGoldengateConnection,
  "GCP.OracleDatabase.GetGoldengateConnection",
  (
    connection: GoldengateConnection,
  ) => Effect.Effect<
    (
      request?: GetGoldengateConnectionRequest,
    ) => Effect.Effect<
      oracle.GoldengateConnection,
      oracle.GetProjectsLocationsGoldengateConnectionsError,
      RuntimeContext
    >
  >
> {}

export const GetGoldengateConnection = Binding.Service<GetGoldengateConnection>(
  "GCP.OracleDatabase.GetGoldengateConnection",
);

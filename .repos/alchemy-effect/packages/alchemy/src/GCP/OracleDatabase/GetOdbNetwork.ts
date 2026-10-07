import type * as oracle from "@distilled.cloud/gcp/oracledatabase_v1";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { RuntimeContext } from "../../RuntimeContext.ts";
import type { OdbNetwork } from "./OdbNetwork.ts";

export interface GetOdbNetworkRequest extends Omit<
  oracle.GetProjectsLocationsOdbNetworksRequest,
  "name"
> {}

/**
 * Runtime binding for Oracle Database `odbNetworks.get`.
 *
 * ### Observing an ODB Network
 * **Example:** Read the bound network
 * ```typescript
 * const get = yield* GCP.OracleDatabase.GetOdbNetwork(net);
 * const live = yield* get();
 * ```
 *
 * @binding
 * @category OracleDatabase
 */
export interface GetOdbNetwork extends Binding.Service<
  GetOdbNetwork,
  "GCP.OracleDatabase.GetOdbNetwork",
  (
    network: OdbNetwork,
  ) => Effect.Effect<
    (
      request?: GetOdbNetworkRequest,
    ) => Effect.Effect<
      oracle.OdbNetwork,
      oracle.GetProjectsLocationsOdbNetworksError,
      RuntimeContext
    >
  >
> {}

export const GetOdbNetwork = Binding.Service<GetOdbNetwork>(
  "GCP.OracleDatabase.GetOdbNetwork",
);

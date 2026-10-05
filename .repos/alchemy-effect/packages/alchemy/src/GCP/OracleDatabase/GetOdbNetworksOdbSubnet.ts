import type * as oracle from "@distilled.cloud/gcp/oracledatabase_v1";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { RuntimeContext } from "../../RuntimeContext.ts";
import type { OdbNetworksOdbSubnet } from "./OdbNetworksOdbSubnet.ts";

export interface GetOdbNetworksOdbSubnetRequest extends Omit<
  oracle.GetProjectsLocationsOdbNetworksOdbSubnetsRequest,
  "name"
> {}

/**
 * Runtime binding for Oracle Database `odbSubnets.get`.
 *
 * ### Observing an ODB Subnet
 * **Example:** Read the bound subnet
 * ```typescript
 * const get = yield* GCP.OracleDatabase.GetOdbNetworksOdbSubnet(subnet);
 * const live = yield* get();
 * ```
 *
 * @binding
 * @category OracleDatabase
 */
export interface GetOdbNetworksOdbSubnet extends Binding.Service<
  GetOdbNetworksOdbSubnet,
  "GCP.OracleDatabase.GetOdbNetworksOdbSubnet",
  (
    subnet: OdbNetworksOdbSubnet,
  ) => Effect.Effect<
    (
      request?: GetOdbNetworksOdbSubnetRequest,
    ) => Effect.Effect<
      oracle.OdbSubnet,
      oracle.GetProjectsLocationsOdbNetworksOdbSubnetsError,
      RuntimeContext
    >
  >
> {}

export const GetOdbNetworksOdbSubnet = Binding.Service<GetOdbNetworksOdbSubnet>(
  "GCP.OracleDatabase.GetOdbNetworksOdbSubnet",
);

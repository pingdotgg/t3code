import type * as emrc from "@distilled.cloud/aws/emr-containers";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { VirtualCluster } from "./VirtualCluster.ts";

/**
 * Runtime binding for `emr-containers:ListManagedEndpoints`.
 *
 * Lists managed endpoints (EMR Studio gateways) on the bound
 * {@link VirtualCluster}, optionally filtered by state or type. The virtual
 * cluster ID is injected from the binding. Provide the implementation with
 * `Effect.provide(AWS.EMRContainers.ListManagedEndpointsHttp)`.
 * @binding
 * @section Managed Endpoints
 * @example List Active Endpoints
 * ```typescript
 * // init
 * const listManagedEndpoints =
 *   yield* AWS.EMRContainers.ListManagedEndpoints(virtualCluster);
 *
 * // runtime
 * const { endpoints } = yield* listManagedEndpoints({ states: ["ACTIVE"] });
 * ```
 */
export interface ListManagedEndpoints extends Binding.Service<
  ListManagedEndpoints,
  "AWS.EMRContainers.ListManagedEndpoints",
  (
    virtualCluster: VirtualCluster,
  ) => Effect.Effect<
    (
      request?: Omit<emrc.ListManagedEndpointsRequest, "virtualClusterId">,
    ) => Effect.Effect<
      emrc.ListManagedEndpointsResponse,
      emrc.ListManagedEndpointsError
    >
  >
> {}
export const ListManagedEndpoints = Binding.Service<ListManagedEndpoints>(
  "AWS.EMRContainers.ListManagedEndpoints",
);

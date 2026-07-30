import type * as emrc from "@distilled.cloud/aws/emr-containers";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { VirtualCluster } from "./VirtualCluster.ts";

/**
 * Runtime binding for `emr-containers:DescribeManagedEndpoint`.
 *
 * Reads a managed endpoint (the EMR Studio gateway) on the bound
 * {@link VirtualCluster} — its state, server URL, and security group. The
 * virtual cluster ID is injected from the binding; pass the endpoint `id`.
 * Provide the implementation with
 * `Effect.provide(AWS.EMRContainers.DescribeManagedEndpointHttp)`.
 * @binding
 * @section Managed Endpoints
 * @example Check An Endpoint Is Active
 * ```typescript
 * // init
 * const describeManagedEndpoint =
 *   yield* AWS.EMRContainers.DescribeManagedEndpoint(virtualCluster);
 *
 * // runtime
 * const { endpoint } = yield* describeManagedEndpoint({ id: endpointId });
 * yield* Effect.log(`endpoint state: ${endpoint?.state}`);
 * ```
 */
export interface DescribeManagedEndpoint extends Binding.Service<
  DescribeManagedEndpoint,
  "AWS.EMRContainers.DescribeManagedEndpoint",
  (
    virtualCluster: VirtualCluster,
  ) => Effect.Effect<
    (
      request: Omit<emrc.DescribeManagedEndpointRequest, "virtualClusterId">,
    ) => Effect.Effect<
      emrc.DescribeManagedEndpointResponse,
      emrc.DescribeManagedEndpointError
    >
  >
> {}
export const DescribeManagedEndpoint = Binding.Service<DescribeManagedEndpoint>(
  "AWS.EMRContainers.DescribeManagedEndpoint",
);

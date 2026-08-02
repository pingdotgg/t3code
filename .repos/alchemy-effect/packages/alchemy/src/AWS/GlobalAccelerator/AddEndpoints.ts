import type * as ga from "@distilled.cloud/aws/global-accelerator";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { EndpointGroup } from "./EndpointGroup.ts";

/**
 * Runtime binding for `globalaccelerator:AddEndpoints`.
 *
 * Registers additional endpoints (ALB/NLB ARNs, EC2 instance IDs, or Elastic
 * IP allocation IDs) on the bound {@link EndpointGroup} at runtime — the
 * dynamic-scaling counterpart to declaring `endpoints` in the resource
 * props. Unlike a full `UpdateEndpointGroup`, adding endpoints does not
 * touch the group's other endpoints or its health-check configuration. The
 * endpoint group ARN is injected from the binding. Provide the
 * implementation with
 * `Effect.provide(AWS.GlobalAccelerator.AddEndpointsHttp)`.
 * @binding
 * @section Managing Endpoints
 * @example Register an Endpoint Dynamically
 * ```typescript
 * // init — bind the operation to the endpoint group
 * const addEndpoints = yield* AWS.GlobalAccelerator.AddEndpoints(group);
 *
 * // runtime
 * yield* addEndpoints({
 *   EndpointConfigurations: [{ EndpointId: allocationId, Weight: 128 }],
 * });
 * ```
 */
export interface AddEndpoints extends Binding.Service<
  AddEndpoints,
  "AWS.GlobalAccelerator.AddEndpoints",
  (
    endpointGroup: EndpointGroup,
  ) => Effect.Effect<
    (
      request: Omit<ga.AddEndpointsRequest, "EndpointGroupArn">,
    ) => Effect.Effect<ga.AddEndpointsResponse, ga.AddEndpointsError>
  >
> {}
export const AddEndpoints = Binding.Service<AddEndpoints>(
  "AWS.GlobalAccelerator.AddEndpoints",
);

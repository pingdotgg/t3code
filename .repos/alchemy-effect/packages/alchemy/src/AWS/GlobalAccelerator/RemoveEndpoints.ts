import type * as ga from "@distilled.cloud/aws/global-accelerator";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { EndpointGroup } from "./EndpointGroup.ts";

/**
 * Runtime binding for `globalaccelerator:RemoveEndpoints`.
 *
 * Deregisters endpoints from the bound {@link EndpointGroup} at runtime —
 * e.g. draining an instance before it is terminated. Unlike a full
 * `UpdateEndpointGroup`, removing endpoints leaves the group's other
 * endpoints and health-check configuration untouched. The endpoint group
 * ARN is injected from the binding. Provide the implementation with
 * `Effect.provide(AWS.GlobalAccelerator.RemoveEndpointsHttp)`.
 * @binding
 * @section Managing Endpoints
 * @example Deregister an Endpoint
 * ```typescript
 * // init — bind the operation to the endpoint group
 * const removeEndpoints = yield* AWS.GlobalAccelerator.RemoveEndpoints(group);
 *
 * // runtime
 * yield* removeEndpoints({
 *   EndpointIdentifiers: [{ EndpointId: allocationId }],
 * });
 * ```
 */
export interface RemoveEndpoints extends Binding.Service<
  RemoveEndpoints,
  "AWS.GlobalAccelerator.RemoveEndpoints",
  (
    endpointGroup: EndpointGroup,
  ) => Effect.Effect<
    (
      request: Omit<ga.RemoveEndpointsRequest, "EndpointGroupArn">,
    ) => Effect.Effect<ga.RemoveEndpointsResponse, ga.RemoveEndpointsError>
  >
> {}
export const RemoveEndpoints = Binding.Service<RemoveEndpoints>(
  "AWS.GlobalAccelerator.RemoveEndpoints",
);

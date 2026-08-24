import type * as ga from "@distilled.cloud/aws/global-accelerator";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { EndpointGroup } from "./EndpointGroup.ts";

/**
 * Runtime binding for `globalaccelerator:DescribeEndpointGroup`.
 *
 * Reads the bound {@link EndpointGroup}'s live state — most usefully the
 * observed per-endpoint health (`HEALTHY` / `UNHEALTHY` / `INITIAL`) — so a
 * function can monitor regional endpoint health or verify an endpoint it
 * just registered. The endpoint group ARN is injected from the binding.
 * Provide the implementation with
 * `Effect.provide(AWS.GlobalAccelerator.DescribeEndpointGroupHttp)`.
 * @binding
 * @section Observing Endpoint Groups
 * @example Check Endpoint Health
 * ```typescript
 * // init — bind the operation to the endpoint group
 * const describeEndpointGroup =
 *   yield* AWS.GlobalAccelerator.DescribeEndpointGroup(group);
 *
 * // runtime
 * const { EndpointGroup } = yield* describeEndpointGroup({});
 * const unhealthy = (EndpointGroup?.EndpointDescriptions ?? []).filter(
 *   (endpoint) => endpoint.HealthState === "UNHEALTHY",
 * );
 * ```
 */
export interface DescribeEndpointGroup extends Binding.Service<
  DescribeEndpointGroup,
  "AWS.GlobalAccelerator.DescribeEndpointGroup",
  (
    endpointGroup: EndpointGroup,
  ) => Effect.Effect<
    (
      request: Omit<ga.DescribeEndpointGroupRequest, "EndpointGroupArn">,
    ) => Effect.Effect<
      ga.DescribeEndpointGroupResponse,
      ga.DescribeEndpointGroupError
    >
  >
> {}
export const DescribeEndpointGroup = Binding.Service<DescribeEndpointGroup>(
  "AWS.GlobalAccelerator.DescribeEndpointGroup",
);

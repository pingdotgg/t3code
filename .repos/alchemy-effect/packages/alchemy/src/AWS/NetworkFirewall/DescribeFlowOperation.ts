import type * as NFW from "@distilled.cloud/aws/network-firewall";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Firewall } from "./Firewall.ts";

export interface DescribeFlowOperationRequest extends Omit<
  NFW.DescribeFlowOperationRequest,
  "FirewallArn"
> {}

/**
 * Runtime binding for `network-firewall:DescribeFlowOperation` — read the
 * status and definition of a flow capture/flush operation running on the
 * bound {@link Firewall}; the firewall ARN is injected automatically.
 *
 * Provide `NetworkFirewall.DescribeFlowOperationHttp` on the hosting Lambda
 * Function to satisfy the requirement.
 * @binding
 * @section Flow Operations
 * @example Poll a Flow Operation
 * ```typescript
 * // init — grants network-firewall:DescribeFlowOperation on the firewall
 * const describeFlowOperation =
 *   yield* AWS.NetworkFirewall.DescribeFlowOperation(firewall);
 *
 * // runtime
 * const { FlowOperationStatus } = yield* describeFlowOperation({
 *   FlowOperationId: flowOperationId,
 * });
 * ```
 */
export interface DescribeFlowOperation extends Binding.Service<
  DescribeFlowOperation,
  "AWS.NetworkFirewall.DescribeFlowOperation",
  (
    firewall: Firewall,
  ) => Effect.Effect<
    (
      request: DescribeFlowOperationRequest,
    ) => Effect.Effect<
      NFW.DescribeFlowOperationResponse,
      NFW.DescribeFlowOperationError
    >
  >
> {}

export const DescribeFlowOperation = Binding.Service<DescribeFlowOperation>(
  "AWS.NetworkFirewall.DescribeFlowOperation",
);

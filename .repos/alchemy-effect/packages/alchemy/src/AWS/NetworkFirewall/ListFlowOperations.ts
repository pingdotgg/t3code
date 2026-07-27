import type * as NFW from "@distilled.cloud/aws/network-firewall";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Firewall } from "./Firewall.ts";

export interface ListFlowOperationsRequest extends Omit<
  NFW.ListFlowOperationsRequest,
  "FirewallArn"
> {}

/**
 * Runtime binding for `network-firewall:ListFlowOperations` — list the flow
 * capture/flush operations that ran on the bound {@link Firewall}; the
 * firewall ARN is injected automatically.
 *
 * Provide `NetworkFirewall.ListFlowOperationsHttp` on the hosting Lambda
 * Function to satisfy the requirement.
 * @binding
 * @section Flow Operations
 * @example List Recent Flow Captures
 * ```typescript
 * // init — grants network-firewall:ListFlowOperations on the firewall
 * const listFlowOperations =
 *   yield* AWS.NetworkFirewall.ListFlowOperations(firewall);
 *
 * // runtime
 * const { FlowOperations } = yield* listFlowOperations({
 *   FlowOperationType: "FLOW_CAPTURE",
 * });
 * ```
 */
export interface ListFlowOperations extends Binding.Service<
  ListFlowOperations,
  "AWS.NetworkFirewall.ListFlowOperations",
  (
    firewall: Firewall,
  ) => Effect.Effect<
    (
      request?: ListFlowOperationsRequest,
    ) => Effect.Effect<
      NFW.ListFlowOperationsResponse,
      NFW.ListFlowOperationsError
    >
  >
> {}

export const ListFlowOperations = Binding.Service<ListFlowOperations>(
  "AWS.NetworkFirewall.ListFlowOperations",
);

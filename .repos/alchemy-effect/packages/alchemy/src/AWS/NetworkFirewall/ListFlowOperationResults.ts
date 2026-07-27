import type * as NFW from "@distilled.cloud/aws/network-firewall";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Firewall } from "./Firewall.ts";

export interface ListFlowOperationResultsRequest extends Omit<
  NFW.ListFlowOperationResultsRequest,
  "FirewallArn"
> {}

/**
 * Runtime binding for `network-firewall:ListFlowOperationResults` — read the
 * flows a completed flow capture/flush operation collected on the bound
 * {@link Firewall}; the firewall ARN is injected automatically.
 *
 * Provide `NetworkFirewall.ListFlowOperationResultsHttp` on the hosting
 * Lambda Function to satisfy the requirement.
 * @binding
 * @section Flow Operations
 * @example Read Captured Flows
 * ```typescript
 * // init — grants network-firewall:ListFlowOperationResults on the firewall
 * const listFlowOperationResults =
 *   yield* AWS.NetworkFirewall.ListFlowOperationResults(firewall);
 *
 * // runtime
 * const { Flows } = yield* listFlowOperationResults({
 *   FlowOperationId: flowOperationId,
 * });
 * ```
 */
export interface ListFlowOperationResults extends Binding.Service<
  ListFlowOperationResults,
  "AWS.NetworkFirewall.ListFlowOperationResults",
  (
    firewall: Firewall,
  ) => Effect.Effect<
    (
      request: ListFlowOperationResultsRequest,
    ) => Effect.Effect<
      NFW.ListFlowOperationResultsResponse,
      NFW.ListFlowOperationResultsError
    >
  >
> {}

export const ListFlowOperationResults =
  Binding.Service<ListFlowOperationResults>(
    "AWS.NetworkFirewall.ListFlowOperationResults",
  );

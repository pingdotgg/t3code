import type * as NFW from "@distilled.cloud/aws/network-firewall";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Firewall } from "./Firewall.ts";

export interface StartFlowFlushRequest extends Omit<
  NFW.StartFlowFlushRequest,
  "FirewallArn"
> {}

/**
 * Runtime binding for `network-firewall:StartFlowFlush` — flush matching
 * flows from the bound {@link Firewall}'s flow table (impacted flows are
 * re-evaluated as midstream traffic); the firewall ARN is injected
 * automatically.
 *
 * Provide `NetworkFirewall.StartFlowFlushHttp` on the hosting Lambda
 * Function to satisfy the requirement.
 * ### Flow Operations
 * **Example:** Flush Flows to a Host
 * ```typescript
 * // init — grants network-firewall:StartFlowFlush on the firewall
 * const startFlowFlush = yield* AWS.NetworkFirewall.StartFlowFlush(firewall);
 *
 * // runtime
 * const { FlowOperationId } = yield* startFlowFlush({
 *   FlowFilters: [{ SourceAddress: { AddressDefinition: "10.0.1.10/32" } }],
 * });
 * ```
 *
 * @binding
 */
export interface StartFlowFlush extends Binding.Service<
  StartFlowFlush,
  "AWS.NetworkFirewall.StartFlowFlush",
  (
    firewall: Firewall,
  ) => Effect.Effect<
    (
      request: StartFlowFlushRequest,
    ) => Effect.Effect<NFW.StartFlowFlushResponse, NFW.StartFlowFlushError>
  >
> {}

export const StartFlowFlush = Binding.Service<StartFlowFlush>(
  "AWS.NetworkFirewall.StartFlowFlush",
);

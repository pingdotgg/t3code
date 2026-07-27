import type * as NFW from "@distilled.cloud/aws/network-firewall";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Firewall } from "./Firewall.ts";

export interface StartFlowCaptureRequest extends Omit<
  NFW.StartFlowCaptureRequest,
  "FirewallArn"
> {}

/**
 * Runtime binding for `network-firewall:StartFlowCapture` — begin a
 * time-boxed capture of the flows the bound {@link Firewall} is tracking,
 * according to the `FlowFilters` you define; the firewall ARN is injected
 * automatically.
 *
 * Provide `NetworkFirewall.StartFlowCaptureHttp` on the hosting Lambda
 * Function to satisfy the requirement.
 * @binding
 * @section Flow Operations
 * @example Capture Flows to a Host
 * ```typescript
 * // init — grants network-firewall:StartFlowCapture on the firewall
 * const startFlowCapture = yield* AWS.NetworkFirewall.StartFlowCapture(firewall);
 *
 * // runtime
 * const { FlowOperationId } = yield* startFlowCapture({
 *   FlowFilters: [{ SourceAddress: { AddressDefinition: "10.0.1.10/32" } }],
 * });
 * ```
 */
export interface StartFlowCapture extends Binding.Service<
  StartFlowCapture,
  "AWS.NetworkFirewall.StartFlowCapture",
  (
    firewall: Firewall,
  ) => Effect.Effect<
    (
      request: StartFlowCaptureRequest,
    ) => Effect.Effect<NFW.StartFlowCaptureResponse, NFW.StartFlowCaptureError>
  >
> {}

export const StartFlowCapture = Binding.Service<StartFlowCapture>(
  "AWS.NetworkFirewall.StartFlowCapture",
);

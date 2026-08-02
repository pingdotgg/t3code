import type * as mediaconnect from "@distilled.cloud/aws/mediaconnect";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Flow } from "./Flow.ts";

/**
 * Runtime binding for `mediaconnect:RevokeFlowEntitlement`.
 *
 * Revokes an entitlement previously granted on the bound {@link Flow} —
 * the content immediately becomes unavailable to the subscriber and the
 * associated output is removed from the flow. The flow ARN is injected
 * from the binding; the entitlement to revoke is passed at runtime.
 * Because the IAM resource types for this action are the flow AND the
 * entitlement (a sibling ARN, not derived from the flow ARN), the
 * deploy-time grant covers the flow ARN plus the entitlement wildcard.
 * Provide the implementation with
 * `Effect.provide(AWS.MediaConnect.RevokeFlowEntitlementHttp)`.
 * @binding
 * @section Managing Entitlements
 * @example Revoke a Subscriber's Access
 * ```typescript
 * // init — bind the operation to the flow
 * const revokeEntitlement = yield* AWS.MediaConnect.RevokeFlowEntitlement(flow);
 *
 * // runtime
 * yield* revokeEntitlement({ EntitlementArn: entitlementArn });
 * ```
 */
export interface RevokeFlowEntitlement extends Binding.Service<
  RevokeFlowEntitlement,
  "AWS.MediaConnect.RevokeFlowEntitlement",
  (
    flow: Flow,
  ) => Effect.Effect<
    (
      request: Omit<mediaconnect.RevokeFlowEntitlementRequest, "FlowArn">,
    ) => Effect.Effect<
      mediaconnect.RevokeFlowEntitlementResponse,
      mediaconnect.RevokeFlowEntitlementError
    >
  >
> {}
export const RevokeFlowEntitlement = Binding.Service<RevokeFlowEntitlement>(
  "AWS.MediaConnect.RevokeFlowEntitlement",
);

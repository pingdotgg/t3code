import type * as fms from "@distilled.cloud/aws/fms";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Request for {@link PutPolicy}.
 */
export interface PutPolicyRequest extends fms.PutPolicyRequest {}

/**
 * Runtime binding for `fms:PutPolicy`.
 *
 * Creates or updates a Firewall Manager policy — a WAF, Shield Advanced, security group, Network Firewall, DNS Firewall, or network ACL policy applied across the organization's accounts. Provide the
 * implementation with `Effect.provide(AWS.FMS.PutPolicyHttp)`.
 * @binding
 * @section Managing Policies
 * @example Create a Policy
 * ```typescript
 * // init — account-level binding takes no resource
 * const putPolicy = yield* AWS.FMS.PutPolicy();
 *
 * // runtime
 * const result = yield* putPolicy({
 *   Policy: {
 *     PolicyName: "org-waf-baseline",
 *     SecurityServicePolicyData: { Type: "WAFV2", ManagedServiceData: "..." },
 *     ResourceType: "AWS::ElasticLoadBalancingV2::LoadBalancer",
 *     ExcludeResourceTags: false,
 *     RemediationEnabled: true,
 *   },
 * });
 * console.log(result.Policy?.PolicyId);
 * ```
 */
export interface PutPolicy extends Binding.Service<
  PutPolicy,
  "AWS.FMS.PutPolicy",
  () => Effect.Effect<
    (
      request: PutPolicyRequest,
    ) => Effect.Effect<fms.PutPolicyResponse, fms.PutPolicyError>
  >
> {}

export const PutPolicy = Binding.Service<PutPolicy>("AWS.FMS.PutPolicy");

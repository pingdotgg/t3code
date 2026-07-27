import type * as WAFV2 from "@distilled.cloud/aws/wafv2";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `wafv2:GetWebACLForResource` — look up which web ACL
 * (if any) protects an arbitrary regional resource (ALB, API Gateway
 * stage, AppSync API, Cognito user pool, ...). A resource with no web ACL
 * association fails with the typed `WAFNonexistentItemException`.
 *
 * Provide `WAFv2.GetWebACLForResourceHttp` on the hosting Lambda Function
 * to satisfy the requirement.
 * @binding
 * @section Inspecting Associations
 * @example Look Up the Web ACL Protecting a Load Balancer
 * ```typescript
 * // init — grants wafv2:GetWebACLForResource + wafv2:GetWebACL
 * const getWebACLForResource = yield* AWS.WAFv2.GetWebACLForResource();
 *
 * // runtime
 * const { WebACL } = yield* getWebACLForResource({
 *   ResourceArn: loadBalancerArn,
 * });
 * ```
 */
export interface GetWebACLForResource extends Binding.Service<
  GetWebACLForResource,
  "AWS.WAFv2.GetWebACLForResource",
  () => Effect.Effect<
    (
      request: WAFV2.GetWebACLForResourceRequest,
    ) => Effect.Effect<
      WAFV2.GetWebACLForResourceResponse,
      WAFV2.GetWebACLForResourceError
    >
  >
> {}

export const GetWebACLForResource = Binding.Service<GetWebACLForResource>(
  "AWS.WAFv2.GetWebACLForResource",
);

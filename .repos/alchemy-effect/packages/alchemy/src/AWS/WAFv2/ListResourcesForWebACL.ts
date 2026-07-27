import type * as WAFV2 from "@distilled.cloud/aws/wafv2";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { WebACL } from "./WebACL.ts";

export interface ListResourcesForWebACLRequest extends Omit<
  WAFV2.ListResourcesForWebACLRequest,
  "WebACLArn"
> {}

/**
 * Runtime binding for `wafv2:ListResourcesForWebACL` — list the regional
 * resources (ALBs, API Gateway stages, AppSync APIs, ...) associated with
 * the bound {@link WebACL}; the web ACL ARN is injected automatically.
 *
 * Provide `WAFv2.ListResourcesForWebACLHttp` on the hosting Lambda Function
 * to satisfy the requirement.
 * @binding
 * @section Inspecting Associations
 * @example List Protected Resources
 * ```typescript
 * // init — grants wafv2:ListResourcesForWebACL on the web ACL
 * const listResources = yield* AWS.WAFv2.ListResourcesForWebACL(acl);
 *
 * // runtime
 * const { ResourceArns } = yield* listResources();
 * ```
 */
export interface ListResourcesForWebACL extends Binding.Service<
  ListResourcesForWebACL,
  "AWS.WAFv2.ListResourcesForWebACL",
  (
    webAcl: WebACL,
  ) => Effect.Effect<
    (
      request?: ListResourcesForWebACLRequest,
    ) => Effect.Effect<
      WAFV2.ListResourcesForWebACLResponse,
      WAFV2.ListResourcesForWebACLError
    >
  >
> {}

export const ListResourcesForWebACL = Binding.Service<ListResourcesForWebACL>(
  "AWS.WAFv2.ListResourcesForWebACL",
);

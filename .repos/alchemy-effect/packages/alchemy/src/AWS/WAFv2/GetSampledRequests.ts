import type * as WAFV2 from "@distilled.cloud/aws/wafv2";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { WebACL } from "./WebACL.ts";

export interface GetSampledRequestsRequest extends Omit<
  WAFV2.GetSampledRequestsRequest,
  "WebAclArn" | "Scope"
> {}

/**
 * Runtime binding for `wafv2:GetSampledRequests` — read a sample of the web
 * requests that the bound {@link WebACL} evaluated for a given rule and
 * time window; the web ACL ARN and scope are injected automatically.
 *
 * Provide `WAFv2.GetSampledRequestsHttp` on the hosting Lambda Function to
 * satisfy the requirement.
 * @binding
 * @section Inspecting Traffic
 * @example Read Sampled Requests for a Rule
 * ```typescript
 * // init — grants wafv2:GetSampledRequests on the web ACL
 * const getSampledRequests = yield* AWS.WAFv2.GetSampledRequests(acl);
 *
 * // runtime
 * const now = yield* Effect.sync(() => new Date());
 * const { SampledRequests } = yield* getSampledRequests({
 *   RuleMetricName: "rate-limit",
 *   TimeWindow: {
 *     StartTime: new Date(now.getTime() - 60 * 60 * 1000),
 *     EndTime: now,
 *   },
 *   MaxItems: 100,
 * });
 * ```
 */
export interface GetSampledRequests extends Binding.Service<
  GetSampledRequests,
  "AWS.WAFv2.GetSampledRequests",
  (
    webAcl: WebACL,
  ) => Effect.Effect<
    (
      request: GetSampledRequestsRequest,
    ) => Effect.Effect<
      WAFV2.GetSampledRequestsResponse,
      WAFV2.GetSampledRequestsError
    >
  >
> {}

export const GetSampledRequests = Binding.Service<GetSampledRequests>(
  "AWS.WAFv2.GetSampledRequests",
);

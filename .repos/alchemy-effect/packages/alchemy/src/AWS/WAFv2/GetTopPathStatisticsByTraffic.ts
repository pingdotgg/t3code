import type * as WAFV2 from "@distilled.cloud/aws/wafv2";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { WebACL } from "./WebACL.ts";

export interface GetTopPathStatisticsByTrafficRequest extends Omit<
  WAFV2.GetTopPathStatisticsByTrafficRequest,
  "WebAclArn" | "Scope"
> {}

/**
 * Runtime binding for `wafv2:GetTopPathStatisticsByTraffic` — read
 * aggregated statistics about the URI paths receiving the most bot traffic
 * on the bound {@link WebACL}; the web ACL ARN and scope are injected
 * automatically.
 *
 * Requires a pricing plan that includes bot statistics — accounts without
 * it receive the typed `WAFFeatureNotIncludedInPricingPlanException`.
 *
 * Provide `WAFv2.GetTopPathStatisticsByTrafficHttp` on the hosting Lambda
 * Function to satisfy the requirement.
 * @binding
 * @section Inspecting Traffic
 * @example Read Top Bot-Trafficked Paths
 * ```typescript
 * // init — grants wafv2:GetTopPathStatisticsByTraffic on the web ACL
 * const getTopPaths = yield* AWS.WAFv2.GetTopPathStatisticsByTraffic(acl);
 *
 * // runtime
 * const now = yield* Effect.sync(() => new Date());
 * const { PathStatistics } = yield* getTopPaths({
 *   TimeWindow: {
 *     StartTime: new Date(now.getTime() - 60 * 60 * 1000),
 *     EndTime: now,
 *   },
 *   Limit: 10,
 *   NumberOfTopTrafficBotsPerPath: 3,
 * });
 * ```
 */
export interface GetTopPathStatisticsByTraffic extends Binding.Service<
  GetTopPathStatisticsByTraffic,
  "AWS.WAFv2.GetTopPathStatisticsByTraffic",
  (
    webAcl: WebACL,
  ) => Effect.Effect<
    (
      request: GetTopPathStatisticsByTrafficRequest,
    ) => Effect.Effect<
      WAFV2.GetTopPathStatisticsByTrafficResponse,
      WAFV2.GetTopPathStatisticsByTrafficError
    >
  >
> {}

export const GetTopPathStatisticsByTraffic =
  Binding.Service<GetTopPathStatisticsByTraffic>(
    "AWS.WAFv2.GetTopPathStatisticsByTraffic",
  );

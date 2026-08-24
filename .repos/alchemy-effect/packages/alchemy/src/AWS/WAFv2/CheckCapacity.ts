import type * as WAFV2 from "@distilled.cloud/aws/wafv2";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `wafv2:CheckCapacity` — compute the web ACL capacity
 * units (WCU) a set of rules would consume, e.g. before updating an IP set
 * or constructing rules dynamically.
 *
 * Provide `WAFv2.CheckCapacityHttp` on the hosting Lambda Function to
 * satisfy the requirement.
 * @binding
 * @section Account Operations
 * @example Check the WCU Cost of a Rule
 * ```typescript
 * // init — grants wafv2:CheckCapacity
 * const checkCapacity = yield* AWS.WAFv2.CheckCapacity();
 *
 * // runtime
 * const { Capacity } = yield* checkCapacity({
 *   Scope: "REGIONAL",
 *   Rules: [rule],
 * });
 * ```
 */
export interface CheckCapacity extends Binding.Service<
  CheckCapacity,
  "AWS.WAFv2.CheckCapacity",
  () => Effect.Effect<
    (
      request: WAFV2.CheckCapacityRequest,
    ) => Effect.Effect<WAFV2.CheckCapacityResponse, WAFV2.CheckCapacityError>
  >
> {}

export const CheckCapacity = Binding.Service<CheckCapacity>(
  "AWS.WAFv2.CheckCapacity",
);

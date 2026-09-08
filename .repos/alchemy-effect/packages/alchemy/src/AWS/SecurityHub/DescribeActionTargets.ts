import type * as securityhub from "@distilled.cloud/aws/securityhub";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `securityhub:DescribeActionTargets`.
 *
 * Lists the custom action targets defined in the account.
 * Account-level operation — invoked with the caller's request as-is.
 * Provide the implementation with
 * `Effect.provide(AWS.SecurityHub.DescribeActionTargetsHttp)`.
 * ### Custom Actions, Automation Rules & Aggregation
 * **Example:** List Custom Actions
 * ```typescript
 * // init — account-level binding, no resource argument
 * const describeActionTargets = yield* AWS.SecurityHub.DescribeActionTargets();
 *
 * // runtime
 * const { ActionTargets } = yield* describeActionTargets();
 * ```
 *
 * @binding
 */
export interface DescribeActionTargets extends Binding.Service<
  DescribeActionTargets,
  "AWS.SecurityHub.DescribeActionTargets",
  () => Effect.Effect<
    (
      request?: securityhub.DescribeActionTargetsRequest,
    ) => Effect.Effect<
      securityhub.DescribeActionTargetsResponse,
      securityhub.DescribeActionTargetsError
    >
  >
> {}
export const DescribeActionTargets = Binding.Service<DescribeActionTargets>(
  "AWS.SecurityHub.DescribeActionTargets",
);

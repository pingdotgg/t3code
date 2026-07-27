import type * as securityhub from "@distilled.cloud/aws/securityhub";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `securityhub:DescribeStandardsControls`.
 *
 * Lists the controls of an enabled standard with their current status.
 * Account-level operation — invoked with the caller's request as-is.
 * Provide the implementation with
 * `Effect.provide(AWS.SecurityHub.DescribeStandardsControlsHttp)`.
 * @binding
 * @section Standards & Controls
 * @example List a Standard's Controls
 * ```typescript
 * // init — account-level binding, no resource argument
 * const describeStandardsControls = yield* AWS.SecurityHub.DescribeStandardsControls();
 *
 * // runtime
 * const { Controls } = yield* describeStandardsControls({
 *   StandardsSubscriptionArn: subscriptionArn,
 * });
 * ```
 */
export interface DescribeStandardsControls extends Binding.Service<
  DescribeStandardsControls,
  "AWS.SecurityHub.DescribeStandardsControls",
  () => Effect.Effect<
    (
      request: securityhub.DescribeStandardsControlsRequest,
    ) => Effect.Effect<
      securityhub.DescribeStandardsControlsResponse,
      securityhub.DescribeStandardsControlsError
    >
  >
> {}
export const DescribeStandardsControls =
  Binding.Service<DescribeStandardsControls>(
    "AWS.SecurityHub.DescribeStandardsControls",
  );

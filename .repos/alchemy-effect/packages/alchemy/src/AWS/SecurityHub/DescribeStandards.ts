import type * as securityhub from "@distilled.cloud/aws/securityhub";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `securityhub:DescribeStandards`.
 *
 * Lists the security standards available in Security Hub.
 * Account-level operation — invoked with the caller's request as-is.
 * Provide the implementation with
 * `Effect.provide(AWS.SecurityHub.DescribeStandardsHttp)`.
 * @binding
 * @section Standards & Controls
 * @example List Available Standards
 * ```typescript
 * // init — account-level binding, no resource argument
 * const describeStandards = yield* AWS.SecurityHub.DescribeStandards();
 *
 * // runtime
 * const { Standards } = yield* describeStandards();
 * ```
 */
export interface DescribeStandards extends Binding.Service<
  DescribeStandards,
  "AWS.SecurityHub.DescribeStandards",
  () => Effect.Effect<
    (
      request?: securityhub.DescribeStandardsRequest,
    ) => Effect.Effect<
      securityhub.DescribeStandardsResponse,
      securityhub.DescribeStandardsError
    >
  >
> {}
export const DescribeStandards = Binding.Service<DescribeStandards>(
  "AWS.SecurityHub.DescribeStandards",
);

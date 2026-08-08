import type * as shield from "@distilled.cloud/aws/shield";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `shield:DescribeAttackStatistics`.
 *
 * Returns the number and type of DDoS attacks Shield has detected in the last
 * year across all of the account's resources — available to Standard and
 * Advanced customers alike, so it works without a subscription.
 * Provide the implementation with
 * `Effect.provide(AWS.Shield.DescribeAttackStatisticsHttp)`.
 * @binding
 * @section Attack Visibility
 * @example Read the Yearly Attack Statistics
 * ```typescript
 * // init — account-level binding, no resource argument
 * const describeAttackStatistics = yield* AWS.Shield.DescribeAttackStatistics();
 *
 * // runtime
 * const { TimeRange, DataItems } = yield* describeAttackStatistics();
 * ```
 */
export interface DescribeAttackStatistics extends Binding.Service<
  DescribeAttackStatistics,
  "AWS.Shield.DescribeAttackStatistics",
  () => Effect.Effect<
    (
      request?: shield.DescribeAttackStatisticsRequest,
    ) => Effect.Effect<
      shield.DescribeAttackStatisticsResponse,
      shield.DescribeAttackStatisticsError
    >
  >
> {}
export const DescribeAttackStatistics =
  Binding.Service<DescribeAttackStatistics>(
    "AWS.Shield.DescribeAttackStatistics",
  );

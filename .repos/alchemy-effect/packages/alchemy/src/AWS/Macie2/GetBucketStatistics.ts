import type * as macie2 from "@distilled.cloud/aws/macie2";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `macie2:GetBucketStatistics`.
 *
 * Retrieves (queries) aggregated statistical data about all the S3 buckets that Amazon Macie monitors and analyzes for an account.
 * Account-level operation — invoked with the caller's request as-is.
 * Provide the implementation with
 * `Effect.provide(AWS.Macie2.GetBucketStatisticsHttp)`.
 * @binding
 * @section S3 Bucket Inventory
 * @example Aggregate Bucket Statistics
 * ```typescript
 * // init — account-level binding, no resource argument
 * const getBucketStatistics = yield* AWS.Macie2.GetBucketStatistics();
 *
 * // runtime
 * const { bucketCount } = yield* getBucketStatistics({});
 * ```
 */
export interface GetBucketStatistics extends Binding.Service<
  GetBucketStatistics,
  "AWS.Macie2.GetBucketStatistics",
  () => Effect.Effect<
    (
      request?: macie2.GetBucketStatisticsRequest,
    ) => Effect.Effect<
      macie2.GetBucketStatisticsResponse,
      macie2.GetBucketStatisticsError
    >
  >
> {}
export const GetBucketStatistics = Binding.Service<GetBucketStatistics>(
  "AWS.Macie2.GetBucketStatistics",
);

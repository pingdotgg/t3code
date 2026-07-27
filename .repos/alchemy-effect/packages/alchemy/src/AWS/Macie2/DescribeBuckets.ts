import type * as macie2 from "@distilled.cloud/aws/macie2";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `macie2:DescribeBuckets`.
 *
 * Retrieves (queries) statistical data and other information about one or more S3 buckets that Amazon Macie monitors and analyzes for an account.
 * Account-level operation — invoked with the caller's request as-is.
 * Provide the implementation with
 * `Effect.provide(AWS.Macie2.DescribeBucketsHttp)`.
 * @binding
 * @section S3 Bucket Inventory
 * @example Query Macie's Bucket Inventory
 * ```typescript
 * // init — account-level binding, no resource argument
 * const describeBuckets = yield* AWS.Macie2.DescribeBuckets();
 *
 * // runtime
 * const { buckets } = yield* describeBuckets({});
 * ```
 */
export interface DescribeBuckets extends Binding.Service<
  DescribeBuckets,
  "AWS.Macie2.DescribeBuckets",
  () => Effect.Effect<
    (
      request?: macie2.DescribeBucketsRequest,
    ) => Effect.Effect<
      macie2.DescribeBucketsResponse,
      macie2.DescribeBucketsError
    >
  >
> {}
export const DescribeBuckets = Binding.Service<DescribeBuckets>(
  "AWS.Macie2.DescribeBuckets",
);

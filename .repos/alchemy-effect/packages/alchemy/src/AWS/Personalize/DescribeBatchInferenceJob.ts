import type * as personalize from "@distilled.cloud/aws/personalize";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `personalize:DescribeBatchInferenceJob` — Polls a batch inference job for completion — pairs with
 * {@link CreateBatchInferenceJob}.
 * Provide the implementation with
 * `Effect.provide(AWS.Personalize.DescribeBatchInferenceJobHttp)`.
 *
 * @binding
 * @section Batch Inference
 * @example Poll a Batch Job
 * ```typescript
 * // init
 * const describeBatchInferenceJob = yield* Personalize.DescribeBatchInferenceJob();
 *
 * const { batchInferenceJob } = yield* describeBatchInferenceJob({
 *   batchInferenceJobArn,
 * });
 * const done = batchInferenceJob?.status === "ACTIVE";
 * ```
 */
export interface DescribeBatchInferenceJob extends Binding.Service<
  DescribeBatchInferenceJob,
  "AWS.Personalize.DescribeBatchInferenceJob",
  () => Effect.Effect<
    (
      request: personalize.DescribeBatchInferenceJobRequest,
    ) => Effect.Effect<
      personalize.DescribeBatchInferenceJobResponse,
      personalize.DescribeBatchInferenceJobError
    >
  >
> {}
export const DescribeBatchInferenceJob =
  Binding.Service<DescribeBatchInferenceJob>(
    "AWS.Personalize.DescribeBatchInferenceJob",
  );

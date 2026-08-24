import type * as translate from "@distilled.cloud/aws/translate";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `translate:DescribeTextTranslationJob` — get the
 * properties of an asynchronous batch translation job (status, language
 * pair, input/output locations, document counts).
 *
 * @binding
 * @section Batch Translation Jobs
 * @example Describe a batch translation job
 * ```typescript
 * // init
 * const describeJob = yield* AWS.Translate.DescribeTextTranslationJob();
 *
 * // runtime
 * const result = yield* describeJob({ JobId: job.JobId! });
 * // result.TextTranslationJobProperties?.JobStatus
 * ```
 */
export interface DescribeTextTranslationJob extends Binding.Service<
  DescribeTextTranslationJob,
  "AWS.Translate.DescribeTextTranslationJob",
  () => Effect.Effect<
    (
      request: translate.DescribeTextTranslationJobRequest,
    ) => Effect.Effect<
      translate.DescribeTextTranslationJobResponse,
      translate.DescribeTextTranslationJobError
    >
  >
> {}
export const DescribeTextTranslationJob =
  Binding.Service<DescribeTextTranslationJob>(
    "AWS.Translate.DescribeTextTranslationJob",
  );

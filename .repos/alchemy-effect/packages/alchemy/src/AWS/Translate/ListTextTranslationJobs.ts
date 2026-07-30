import type * as translate from "@distilled.cloud/aws/translate";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `translate:ListTextTranslationJobs` — list the batch
 * translation jobs submitted in the account and region, optionally filtered
 * by name, status, or submission time.
 *
 * @binding
 * @section Batch Translation Jobs
 * @example List batch translation jobs
 * ```typescript
 * // init
 * const listJobs = yield* AWS.Translate.ListTextTranslationJobs();
 *
 * // runtime
 * const result = yield* listJobs({
 *   Filter: { JobStatus: "IN_PROGRESS" },
 *   MaxResults: 25,
 * });
 * // result.TextTranslationJobPropertiesList -> [{ JobId, JobStatus, … }, …]
 * ```
 */
export interface ListTextTranslationJobs extends Binding.Service<
  ListTextTranslationJobs,
  "AWS.Translate.ListTextTranslationJobs",
  () => Effect.Effect<
    (
      request?: translate.ListTextTranslationJobsRequest,
    ) => Effect.Effect<
      translate.ListTextTranslationJobsResponse,
      translate.ListTextTranslationJobsError
    >
  >
> {}
export const ListTextTranslationJobs = Binding.Service<ListTextTranslationJobs>(
  "AWS.Translate.ListTextTranslationJobs",
);

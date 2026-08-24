import type * as comprehend from "@distilled.cloud/aws/comprehend";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `comprehend:ListDominantLanguageDetectionJobs` — list the account's
 * asynchronous dominant-language detection jobs, with optional status/name/time filters.
 *
 * The binding takes no arguments and grants the action on `*` (job APIs
 * have no resource-level IAM).
 *
 * @binding
 * @section Monitoring Analysis Jobs
 * @example List Recent DominantLanguageDetection Jobs
 * ```typescript
 * // init
 * const listDominantLanguageDetectionJobs = yield* AWS.Comprehend.ListDominantLanguageDetectionJobs();
 *
 * // runtime
 * const page = yield* listDominantLanguageDetectionJobs({
 *   Filter: { JobStatus: "IN_PROGRESS" },
 *   MaxResults: 25,
 * });
 * // page.DominantLanguageDetectionJobPropertiesList
 * ```
 */
export interface ListDominantLanguageDetectionJobs extends Binding.Service<
  ListDominantLanguageDetectionJobs,
  "AWS.Comprehend.ListDominantLanguageDetectionJobs",
  () => Effect.Effect<
    (
      request?: comprehend.ListDominantLanguageDetectionJobsRequest,
    ) => Effect.Effect<
      comprehend.ListDominantLanguageDetectionJobsResponse,
      comprehend.ListDominantLanguageDetectionJobsError
    >
  >
> {}
export const ListDominantLanguageDetectionJobs =
  Binding.Service<ListDominantLanguageDetectionJobs>(
    "AWS.Comprehend.ListDominantLanguageDetectionJobs",
  );

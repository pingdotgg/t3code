import type * as comprehend from "@distilled.cloud/aws/comprehend";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `comprehend:ListKeyPhrasesDetectionJobs` — list the account's
 * asynchronous key-phrase detection jobs, with optional status/name/time filters.
 *
 * The binding takes no arguments and grants the action on `*` (job APIs
 * have no resource-level IAM).
 *
 * ### Monitoring Analysis Jobs
 * **Example:** List Recent KeyPhrasesDetection Jobs
 * ```typescript
 * // init
 * const listKeyPhrasesDetectionJobs = yield* AWS.Comprehend.ListKeyPhrasesDetectionJobs();
 *
 * // runtime
 * const page = yield* listKeyPhrasesDetectionJobs({
 *   Filter: { JobStatus: "IN_PROGRESS" },
 *   MaxResults: 25,
 * });
 * // page.KeyPhrasesDetectionJobPropertiesList
 * ```
 *
 * @binding
 */
export interface ListKeyPhrasesDetectionJobs extends Binding.Service<
  ListKeyPhrasesDetectionJobs,
  "AWS.Comprehend.ListKeyPhrasesDetectionJobs",
  () => Effect.Effect<
    (
      request?: comprehend.ListKeyPhrasesDetectionJobsRequest,
    ) => Effect.Effect<
      comprehend.ListKeyPhrasesDetectionJobsResponse,
      comprehend.ListKeyPhrasesDetectionJobsError
    >
  >
> {}
export const ListKeyPhrasesDetectionJobs =
  Binding.Service<ListKeyPhrasesDetectionJobs>(
    "AWS.Comprehend.ListKeyPhrasesDetectionJobs",
  );

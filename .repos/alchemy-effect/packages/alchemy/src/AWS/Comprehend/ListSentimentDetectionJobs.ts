import type * as comprehend from "@distilled.cloud/aws/comprehend";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `comprehend:ListSentimentDetectionJobs` — list the account's
 * asynchronous sentiment detection jobs, with optional status/name/time filters.
 *
 * The binding takes no arguments and grants the action on `*` (job APIs
 * have no resource-level IAM).
 *
 * @binding
 * @section Monitoring Analysis Jobs
 * @example List Recent SentimentDetection Jobs
 * ```typescript
 * // init
 * const listSentimentDetectionJobs = yield* AWS.Comprehend.ListSentimentDetectionJobs();
 *
 * // runtime
 * const page = yield* listSentimentDetectionJobs({
 *   Filter: { JobStatus: "IN_PROGRESS" },
 *   MaxResults: 25,
 * });
 * // page.SentimentDetectionJobPropertiesList
 * ```
 */
export interface ListSentimentDetectionJobs extends Binding.Service<
  ListSentimentDetectionJobs,
  "AWS.Comprehend.ListSentimentDetectionJobs",
  () => Effect.Effect<
    (
      request?: comprehend.ListSentimentDetectionJobsRequest,
    ) => Effect.Effect<
      comprehend.ListSentimentDetectionJobsResponse,
      comprehend.ListSentimentDetectionJobsError
    >
  >
> {}
export const ListSentimentDetectionJobs =
  Binding.Service<ListSentimentDetectionJobs>(
    "AWS.Comprehend.ListSentimentDetectionJobs",
  );

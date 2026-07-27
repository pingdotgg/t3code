import type * as comprehend from "@distilled.cloud/aws/comprehend";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `comprehend:ListTargetedSentimentDetectionJobs` — list the account's
 * asynchronous targeted-sentiment detection jobs, with optional status/name/time filters.
 *
 * The binding takes no arguments and grants the action on `*` (job APIs
 * have no resource-level IAM).
 *
 * @binding
 * @section Monitoring Analysis Jobs
 * @example List Recent TargetedSentimentDetection Jobs
 * ```typescript
 * // init
 * const listTargetedSentimentDetectionJobs = yield* AWS.Comprehend.ListTargetedSentimentDetectionJobs();
 *
 * // runtime
 * const page = yield* listTargetedSentimentDetectionJobs({
 *   Filter: { JobStatus: "IN_PROGRESS" },
 *   MaxResults: 25,
 * });
 * // page.TargetedSentimentDetectionJobPropertiesList
 * ```
 */
export interface ListTargetedSentimentDetectionJobs extends Binding.Service<
  ListTargetedSentimentDetectionJobs,
  "AWS.Comprehend.ListTargetedSentimentDetectionJobs",
  () => Effect.Effect<
    (
      request?: comprehend.ListTargetedSentimentDetectionJobsRequest,
    ) => Effect.Effect<
      comprehend.ListTargetedSentimentDetectionJobsResponse,
      comprehend.ListTargetedSentimentDetectionJobsError
    >
  >
> {}
export const ListTargetedSentimentDetectionJobs =
  Binding.Service<ListTargetedSentimentDetectionJobs>(
    "AWS.Comprehend.ListTargetedSentimentDetectionJobs",
  );

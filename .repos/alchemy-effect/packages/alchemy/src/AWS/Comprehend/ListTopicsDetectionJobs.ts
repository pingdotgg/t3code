import type * as comprehend from "@distilled.cloud/aws/comprehend";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `comprehend:ListTopicsDetectionJobs` — list the account's
 * asynchronous topic modeling jobs, with optional status/name/time filters.
 *
 * The binding takes no arguments and grants the action on `*` (job APIs
 * have no resource-level IAM).
 *
 * @binding
 * @section Monitoring Analysis Jobs
 * @example List Recent TopicsDetection Jobs
 * ```typescript
 * // init
 * const listTopicsDetectionJobs = yield* AWS.Comprehend.ListTopicsDetectionJobs();
 *
 * // runtime
 * const page = yield* listTopicsDetectionJobs({
 *   Filter: { JobStatus: "IN_PROGRESS" },
 *   MaxResults: 25,
 * });
 * // page.TopicsDetectionJobPropertiesList
 * ```
 */
export interface ListTopicsDetectionJobs extends Binding.Service<
  ListTopicsDetectionJobs,
  "AWS.Comprehend.ListTopicsDetectionJobs",
  () => Effect.Effect<
    (
      request?: comprehend.ListTopicsDetectionJobsRequest,
    ) => Effect.Effect<
      comprehend.ListTopicsDetectionJobsResponse,
      comprehend.ListTopicsDetectionJobsError
    >
  >
> {}
export const ListTopicsDetectionJobs = Binding.Service<ListTopicsDetectionJobs>(
  "AWS.Comprehend.ListTopicsDetectionJobs",
);

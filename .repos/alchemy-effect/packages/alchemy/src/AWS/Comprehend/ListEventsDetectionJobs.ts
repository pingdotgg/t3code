import type * as comprehend from "@distilled.cloud/aws/comprehend";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `comprehend:ListEventsDetectionJobs` — list the account's
 * asynchronous event detection jobs, with optional status/name/time filters.
 *
 * The binding takes no arguments and grants the action on `*` (job APIs
 * have no resource-level IAM).
 *
 * @binding
 * @section Monitoring Analysis Jobs
 * @example List Recent EventsDetection Jobs
 * ```typescript
 * // init
 * const listEventsDetectionJobs = yield* AWS.Comprehend.ListEventsDetectionJobs();
 *
 * // runtime
 * const page = yield* listEventsDetectionJobs({
 *   Filter: { JobStatus: "IN_PROGRESS" },
 *   MaxResults: 25,
 * });
 * // page.EventsDetectionJobPropertiesList
 * ```
 */
export interface ListEventsDetectionJobs extends Binding.Service<
  ListEventsDetectionJobs,
  "AWS.Comprehend.ListEventsDetectionJobs",
  () => Effect.Effect<
    (
      request?: comprehend.ListEventsDetectionJobsRequest,
    ) => Effect.Effect<
      comprehend.ListEventsDetectionJobsResponse,
      comprehend.ListEventsDetectionJobsError
    >
  >
> {}
export const ListEventsDetectionJobs = Binding.Service<ListEventsDetectionJobs>(
  "AWS.Comprehend.ListEventsDetectionJobs",
);

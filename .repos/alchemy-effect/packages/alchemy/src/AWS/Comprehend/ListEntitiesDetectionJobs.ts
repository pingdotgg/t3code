import type * as comprehend from "@distilled.cloud/aws/comprehend";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `comprehend:ListEntitiesDetectionJobs` — list the account's
 * asynchronous entity detection jobs, with optional status/name/time filters.
 *
 * The binding takes no arguments and grants the action on `*` (job APIs
 * have no resource-level IAM).
 *
 * @binding
 * @section Monitoring Analysis Jobs
 * @example List Recent EntitiesDetection Jobs
 * ```typescript
 * // init
 * const listEntitiesDetectionJobs = yield* AWS.Comprehend.ListEntitiesDetectionJobs();
 *
 * // runtime
 * const page = yield* listEntitiesDetectionJobs({
 *   Filter: { JobStatus: "IN_PROGRESS" },
 *   MaxResults: 25,
 * });
 * // page.EntitiesDetectionJobPropertiesList
 * ```
 */
export interface ListEntitiesDetectionJobs extends Binding.Service<
  ListEntitiesDetectionJobs,
  "AWS.Comprehend.ListEntitiesDetectionJobs",
  () => Effect.Effect<
    (
      request?: comprehend.ListEntitiesDetectionJobsRequest,
    ) => Effect.Effect<
      comprehend.ListEntitiesDetectionJobsResponse,
      comprehend.ListEntitiesDetectionJobsError
    >
  >
> {}
export const ListEntitiesDetectionJobs =
  Binding.Service<ListEntitiesDetectionJobs>(
    "AWS.Comprehend.ListEntitiesDetectionJobs",
  );

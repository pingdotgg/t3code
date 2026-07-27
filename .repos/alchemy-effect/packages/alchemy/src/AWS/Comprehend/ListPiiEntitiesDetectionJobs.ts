import type * as comprehend from "@distilled.cloud/aws/comprehend";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `comprehend:ListPiiEntitiesDetectionJobs` — list the account's
 * asynchronous PII entity detection jobs, with optional status/name/time filters.
 *
 * The binding takes no arguments and grants the action on `*` (job APIs
 * have no resource-level IAM).
 *
 * @binding
 * @section Monitoring Analysis Jobs
 * @example List Recent PiiEntitiesDetection Jobs
 * ```typescript
 * // init
 * const listPiiEntitiesDetectionJobs = yield* AWS.Comprehend.ListPiiEntitiesDetectionJobs();
 *
 * // runtime
 * const page = yield* listPiiEntitiesDetectionJobs({
 *   Filter: { JobStatus: "IN_PROGRESS" },
 *   MaxResults: 25,
 * });
 * // page.PiiEntitiesDetectionJobPropertiesList
 * ```
 */
export interface ListPiiEntitiesDetectionJobs extends Binding.Service<
  ListPiiEntitiesDetectionJobs,
  "AWS.Comprehend.ListPiiEntitiesDetectionJobs",
  () => Effect.Effect<
    (
      request?: comprehend.ListPiiEntitiesDetectionJobsRequest,
    ) => Effect.Effect<
      comprehend.ListPiiEntitiesDetectionJobsResponse,
      comprehend.ListPiiEntitiesDetectionJobsError
    >
  >
> {}
export const ListPiiEntitiesDetectionJobs =
  Binding.Service<ListPiiEntitiesDetectionJobs>(
    "AWS.Comprehend.ListPiiEntitiesDetectionJobs",
  );

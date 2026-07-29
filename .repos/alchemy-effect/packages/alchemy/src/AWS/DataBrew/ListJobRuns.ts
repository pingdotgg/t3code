import type * as SVC from "@distilled.cloud/aws/databrew";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Job } from "./Job.ts";

export interface ListJobRunsRequest extends Omit<
  SVC.ListJobRunsRequest,
  "Name"
> {}

/**
 * Runtime binding for `databrew:ListJobRuns` — lists the previous runs of
 * the bound DataBrew job (newest first, paginated via `NextToken`).
 * @binding
 * @section Observing Job Runs
 * @example List Recent Runs
 * ```typescript
 * const listJobRuns = yield* AWS.DataBrew.ListJobRuns(job);
 *
 * const { JobRuns } = yield* listJobRuns();
 * ```
 */
export interface ListJobRuns extends Binding.Service<
  ListJobRuns,
  "AWS.DataBrew.ListJobRuns",
  <J extends Job>(
    job: J,
  ) => Effect.Effect<
    (
      request?: ListJobRunsRequest,
    ) => Effect.Effect<SVC.ListJobRunsResponse, SVC.ListJobRunsError>
  >
> {}
export const ListJobRuns = Binding.Service<ListJobRuns>(
  "AWS.DataBrew.ListJobRuns",
);

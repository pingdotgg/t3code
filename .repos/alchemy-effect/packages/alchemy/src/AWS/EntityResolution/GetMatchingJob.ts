import type * as entityresolution from "@distilled.cloud/aws/entityresolution";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { MatchingWorkflow } from "./MatchingWorkflow.ts";

/**
 * Runtime binding for `entityresolution:GetMatchingJob`.
 *
 * Reads the status, metrics, and errors of a matching job run of the bound
 * workflow. Provide the implementation with
 * `Effect.provide(AWS.EntityResolution.GetMatchingJobHttp)`.
 * @binding
 * @section Running Matching Jobs
 * @example Poll a Job's Status
 * ```typescript
 * // init — bind the operation to the workflow
 * const getMatchingJob = yield* AWS.EntityResolution.GetMatchingJob(workflow);
 *
 * // runtime
 * const job = yield* getMatchingJob({ jobId });
 * console.log(job.status, job.metrics?.matchIDs);
 * ```
 */
export interface GetMatchingJob extends Binding.Service<
  GetMatchingJob,
  "AWS.EntityResolution.GetMatchingJob",
  (
    workflow: MatchingWorkflow,
  ) => Effect.Effect<
    (
      request: Omit<entityresolution.GetMatchingJobInput, "workflowName">,
    ) => Effect.Effect<
      entityresolution.GetMatchingJobOutput,
      entityresolution.GetMatchingJobError
    >
  >
> {}

export const GetMatchingJob = Binding.Service<GetMatchingJob>(
  "AWS.EntityResolution.GetMatchingJob",
);

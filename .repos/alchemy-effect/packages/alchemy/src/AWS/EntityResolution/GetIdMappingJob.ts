import type * as entityresolution from "@distilled.cloud/aws/entityresolution";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { IdMappingWorkflow } from "./IdMappingWorkflow.ts";

/**
 * Runtime binding for `entityresolution:GetIdMappingJob`.
 *
 * Reads the status, metrics, and errors of an ID mapping job run of the
 * bound workflow. Provide the implementation with
 * `Effect.provide(AWS.EntityResolution.GetIdMappingJobHttp)`.
 * @binding
 * @section Running ID Mapping Jobs
 * @example Poll a Job's Status
 * ```typescript
 * // init — bind the operation to the workflow
 * const getIdMappingJob = yield* AWS.EntityResolution.GetIdMappingJob(workflow);
 *
 * // runtime
 * const job = yield* getIdMappingJob({ jobId });
 * console.log(job.status, job.metrics?.totalMappedRecords);
 * ```
 */
export interface GetIdMappingJob extends Binding.Service<
  GetIdMappingJob,
  "AWS.EntityResolution.GetIdMappingJob",
  (
    workflow: IdMappingWorkflow,
  ) => Effect.Effect<
    (
      request: Omit<entityresolution.GetIdMappingJobInput, "workflowName">,
    ) => Effect.Effect<
      entityresolution.GetIdMappingJobOutput,
      entityresolution.GetIdMappingJobError
    >
  >
> {}

export const GetIdMappingJob = Binding.Service<GetIdMappingJob>(
  "AWS.EntityResolution.GetIdMappingJob",
);

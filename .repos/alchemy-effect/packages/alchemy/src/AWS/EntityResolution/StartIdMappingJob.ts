import type * as entityresolution from "@distilled.cloud/aws/entityresolution";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { IdMappingWorkflow } from "./IdMappingWorkflow.ts";

/**
 * Runtime binding for `entityresolution:StartIdMappingJob`.
 *
 * Starts an ID mapping job run of the bound workflow — a batch process over
 * the workflow's full input that takes many minutes. Provide the
 * implementation with `Effect.provide(AWS.EntityResolution.StartIdMappingJobHttp)`.
 * @binding
 * @section Running ID Mapping Jobs
 * @example Start a Job
 * ```typescript
 * // init — bind the operation to the workflow
 * const startIdMappingJob = yield* AWS.EntityResolution.StartIdMappingJob(workflow);
 *
 * // runtime
 * const { jobId } = yield* startIdMappingJob({});
 * ```
 */
export interface StartIdMappingJob extends Binding.Service<
  StartIdMappingJob,
  "AWS.EntityResolution.StartIdMappingJob",
  (
    workflow: IdMappingWorkflow,
  ) => Effect.Effect<
    (
      request: Omit<entityresolution.StartIdMappingJobInput, "workflowName">,
    ) => Effect.Effect<
      entityresolution.StartIdMappingJobOutput,
      entityresolution.StartIdMappingJobError
    >
  >
> {}

export const StartIdMappingJob = Binding.Service<StartIdMappingJob>(
  "AWS.EntityResolution.StartIdMappingJob",
);

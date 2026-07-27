import type * as entityresolution from "@distilled.cloud/aws/entityresolution";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { MatchingWorkflow } from "./MatchingWorkflow.ts";

/**
 * Runtime binding for `entityresolution:StartMatchingJob`.
 *
 * Starts a matching job run of the bound workflow — a batch process over the
 * workflow's full input that takes many minutes. Provide the implementation
 * with `Effect.provide(AWS.EntityResolution.StartMatchingJobHttp)`.
 * @binding
 * @section Running Matching Jobs
 * @example Start a Job
 * ```typescript
 * // init — bind the operation to the workflow
 * const startMatchingJob = yield* AWS.EntityResolution.StartMatchingJob(workflow);
 *
 * // runtime
 * const { jobId } = yield* startMatchingJob({});
 * ```
 */
export interface StartMatchingJob extends Binding.Service<
  StartMatchingJob,
  "AWS.EntityResolution.StartMatchingJob",
  (
    workflow: MatchingWorkflow,
  ) => Effect.Effect<
    (
      request: Omit<entityresolution.StartMatchingJobInput, "workflowName">,
    ) => Effect.Effect<
      entityresolution.StartMatchingJobOutput,
      entityresolution.StartMatchingJobError
    >
  >
> {}

export const StartMatchingJob = Binding.Service<StartMatchingJob>(
  "AWS.EntityResolution.StartMatchingJob",
);

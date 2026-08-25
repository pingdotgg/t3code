import type * as entityresolution from "@distilled.cloud/aws/entityresolution";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { MatchingWorkflow } from "./MatchingWorkflow.ts";

/**
 * Runtime binding for `entityresolution:ListMatchingJobs`.
 *
 * Lists the matching job runs of the bound workflow. Provide the
 * implementation with `Effect.provide(AWS.EntityResolution.ListMatchingJobsHttp)`.
 * @binding
 * @section Running Matching Jobs
 * @example List Recent Jobs
 * ```typescript
 * // init — bind the operation to the workflow
 * const listMatchingJobs = yield* AWS.EntityResolution.ListMatchingJobs(workflow);
 *
 * // runtime
 * const { jobs } = yield* listMatchingJobs({});
 * ```
 */
export interface ListMatchingJobs extends Binding.Service<
  ListMatchingJobs,
  "AWS.EntityResolution.ListMatchingJobs",
  (
    workflow: MatchingWorkflow,
  ) => Effect.Effect<
    (
      request: Omit<entityresolution.ListMatchingJobsInput, "workflowName">,
    ) => Effect.Effect<
      entityresolution.ListMatchingJobsOutput,
      entityresolution.ListMatchingJobsError
    >
  >
> {}

export const ListMatchingJobs = Binding.Service<ListMatchingJobs>(
  "AWS.EntityResolution.ListMatchingJobs",
);

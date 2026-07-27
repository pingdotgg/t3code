import type * as entityresolution from "@distilled.cloud/aws/entityresolution";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { IdMappingWorkflow } from "./IdMappingWorkflow.ts";

/**
 * Runtime binding for `entityresolution:ListIdMappingJobs`.
 *
 * Lists the ID mapping job runs of the bound workflow. Provide the
 * implementation with `Effect.provide(AWS.EntityResolution.ListIdMappingJobsHttp)`.
 * @binding
 * @section Running ID Mapping Jobs
 * @example List Recent Jobs
 * ```typescript
 * // init — bind the operation to the workflow
 * const listIdMappingJobs = yield* AWS.EntityResolution.ListIdMappingJobs(workflow);
 *
 * // runtime
 * const { jobs } = yield* listIdMappingJobs({});
 * ```
 */
export interface ListIdMappingJobs extends Binding.Service<
  ListIdMappingJobs,
  "AWS.EntityResolution.ListIdMappingJobs",
  (
    workflow: IdMappingWorkflow,
  ) => Effect.Effect<
    (
      request: Omit<entityresolution.ListIdMappingJobsInput, "workflowName">,
    ) => Effect.Effect<
      entityresolution.ListIdMappingJobsOutput,
      entityresolution.ListIdMappingJobsError
    >
  >
> {}

export const ListIdMappingJobs = Binding.Service<ListIdMappingJobs>(
  "AWS.EntityResolution.ListIdMappingJobs",
);

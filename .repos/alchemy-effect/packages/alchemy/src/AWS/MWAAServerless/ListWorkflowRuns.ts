import type * as mwaa from "@distilled.cloud/aws/mwaa-serverless";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Workflow } from "./Workflow.ts";

/**
 * Request accepted by the {@link ListWorkflowRuns} runtime callable. The
 * `WorkflowArn` is injected from the bound {@link Workflow}.
 */
export type ListWorkflowRunsInput = Omit<
  mwaa.ListWorkflowRunsRequest,
  "WorkflowArn"
>;

/**
 * Runtime binding for `airflow-serverless:ListWorkflowRuns`.
 *
 * Lists runs of the bound {@link Workflow}, optionally filtered to a
 * specific workflow version. Provide the implementation with
 * `Effect.provide(AWS.MWAAServerless.ListWorkflowRunsHttp)`.
 * @binding
 * @section Observing Runs
 * @example List Recent Runs
 * ```typescript
 * // init — bind the operation to the workflow
 * const listWorkflowRuns = yield* AWS.MWAAServerless.ListWorkflowRuns(workflow);
 *
 * // runtime
 * const { WorkflowRuns } = yield* listWorkflowRuns({ MaxResults: 10 });
 * yield* Effect.log(`found ${WorkflowRuns?.length ?? 0} runs`);
 * ```
 */
export interface ListWorkflowRuns extends Binding.Service<
  ListWorkflowRuns,
  "AWS.MWAAServerless.ListWorkflowRuns",
  (
    workflow: Workflow,
  ) => Effect.Effect<
    (
      request?: ListWorkflowRunsInput,
    ) => Effect.Effect<
      mwaa.ListWorkflowRunsResponse,
      mwaa.ListWorkflowRunsError
    >
  >
> {}
export const ListWorkflowRuns = Binding.Service<ListWorkflowRuns>(
  "AWS.MWAAServerless.ListWorkflowRuns",
);

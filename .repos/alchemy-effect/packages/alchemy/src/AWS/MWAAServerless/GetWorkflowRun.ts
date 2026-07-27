import type * as mwaa from "@distilled.cloud/aws/mwaa-serverless";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Workflow } from "./Workflow.ts";

/**
 * Request accepted by the {@link GetWorkflowRun} runtime callable. The
 * `WorkflowArn` is injected from the bound {@link Workflow}.
 */
export type GetWorkflowRunInput = Omit<
  mwaa.GetWorkflowRunRequest,
  "WorkflowArn"
>;

/**
 * Runtime binding for `airflow-serverless:GetWorkflowRun`.
 *
 * Reads the detail of a single run of the bound {@link Workflow} — its
 * status, timings, error message, and task-instance ids. Provide the
 * implementation with `Effect.provide(AWS.MWAAServerless.GetWorkflowRunHttp)`.
 * @binding
 * @section Observing Runs
 * @example Read A Run's Status
 * ```typescript
 * // init — bind the operation to the workflow
 * const getWorkflowRun = yield* AWS.MWAAServerless.GetWorkflowRun(workflow);
 *
 * // runtime
 * const run = yield* getWorkflowRun({ RunId: runId });
 * yield* Effect.log(`run ${run.RunId}: ${run.RunDetail?.RunState}`);
 * ```
 */
export interface GetWorkflowRun extends Binding.Service<
  GetWorkflowRun,
  "AWS.MWAAServerless.GetWorkflowRun",
  (
    workflow: Workflow,
  ) => Effect.Effect<
    (
      request: GetWorkflowRunInput,
    ) => Effect.Effect<mwaa.GetWorkflowRunResponse, mwaa.GetWorkflowRunError>
  >
> {}
export const GetWorkflowRun = Binding.Service<GetWorkflowRun>(
  "AWS.MWAAServerless.GetWorkflowRun",
);

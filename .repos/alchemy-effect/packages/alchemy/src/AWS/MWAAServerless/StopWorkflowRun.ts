import type * as mwaa from "@distilled.cloud/aws/mwaa-serverless";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Workflow } from "./Workflow.ts";

/**
 * Request accepted by the {@link StopWorkflowRun} runtime callable. The
 * `WorkflowArn` is injected from the bound {@link Workflow}.
 */
export type StopWorkflowRunInput = Omit<
  mwaa.StopWorkflowRunRequest,
  "WorkflowArn"
>;

/**
 * Runtime binding for `airflow-serverless:StopWorkflowRun`.
 *
 * Stops an in-flight run of the bound {@link Workflow}. Provide the
 * implementation with `Effect.provide(AWS.MWAAServerless.StopWorkflowRunHttp)`.
 * ### Running Workflows
 * **Example:** Stop A Run
 * ```typescript
 * // init — bind the operation to the workflow
 * const stopWorkflowRun = yield* AWS.MWAAServerless.StopWorkflowRun(workflow);
 *
 * // runtime
 * const stopped = yield* stopWorkflowRun({ RunId: runId });
 * yield* Effect.log(`run ${stopped.RunId} -> ${stopped.Status}`);
 * ```
 *
 * @binding
 */
export interface StopWorkflowRun extends Binding.Service<
  StopWorkflowRun,
  "AWS.MWAAServerless.StopWorkflowRun",
  (
    workflow: Workflow,
  ) => Effect.Effect<
    (
      request: StopWorkflowRunInput,
    ) => Effect.Effect<mwaa.StopWorkflowRunResponse, mwaa.StopWorkflowRunError>
  >
> {}
export const StopWorkflowRun = Binding.Service<StopWorkflowRun>(
  "AWS.MWAAServerless.StopWorkflowRun",
);

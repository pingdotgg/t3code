import type * as mwaa from "@distilled.cloud/aws/mwaa-serverless";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Workflow } from "./Workflow.ts";

/**
 * Request accepted by the {@link GetTaskInstance} runtime callable. The
 * `WorkflowArn` is injected from the bound {@link Workflow}.
 */
export type GetTaskInstanceInput = Omit<
  mwaa.GetTaskInstanceRequest,
  "WorkflowArn"
>;

/**
 * Runtime binding for `airflow-serverless:GetTaskInstance`.
 *
 * Reads the detail of a single task instance within a run of the bound
 * {@link Workflow} — its status, attempt number, timings, error message,
 * log stream, and XCom values. Provide the implementation with
 * `Effect.provide(AWS.MWAAServerless.GetTaskInstanceHttp)`.
 * @binding
 * @section Observing Tasks
 * @example Read A Task Instance
 * ```typescript
 * // init — bind the operation to the workflow
 * const getTaskInstance = yield* AWS.MWAAServerless.GetTaskInstance(workflow);
 *
 * // runtime
 * const task = yield* getTaskInstance({
 *   RunId: runId,
 *   TaskInstanceId: taskInstanceId,
 * });
 * yield* Effect.log(`task ${task.TaskId}: ${task.Status}`);
 * ```
 */
export interface GetTaskInstance extends Binding.Service<
  GetTaskInstance,
  "AWS.MWAAServerless.GetTaskInstance",
  (
    workflow: Workflow,
  ) => Effect.Effect<
    (
      request: GetTaskInstanceInput,
    ) => Effect.Effect<mwaa.GetTaskInstanceResponse, mwaa.GetTaskInstanceError>
  >
> {}
export const GetTaskInstance = Binding.Service<GetTaskInstance>(
  "AWS.MWAAServerless.GetTaskInstance",
);

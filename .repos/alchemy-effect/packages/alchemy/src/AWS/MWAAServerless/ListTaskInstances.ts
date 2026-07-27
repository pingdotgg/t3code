import type * as mwaa from "@distilled.cloud/aws/mwaa-serverless";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Workflow } from "./Workflow.ts";

/**
 * Request accepted by the {@link ListTaskInstances} runtime callable. The
 * `WorkflowArn` is injected from the bound {@link Workflow}.
 */
export type ListTaskInstancesInput = Omit<
  mwaa.ListTaskInstancesRequest,
  "WorkflowArn"
>;

/**
 * Runtime binding for `airflow-serverless:ListTaskInstances`.
 *
 * Lists the task instances of a run of the bound {@link Workflow} with
 * their statuses and durations. Provide the implementation with
 * `Effect.provide(AWS.MWAAServerless.ListTaskInstancesHttp)`.
 * @binding
 * @section Observing Tasks
 * @example List A Run's Task Instances
 * ```typescript
 * // init — bind the operation to the workflow
 * const listTaskInstances = yield* AWS.MWAAServerless.ListTaskInstances(workflow);
 *
 * // runtime
 * const { TaskInstances } = yield* listTaskInstances({ RunId: runId });
 * for (const task of TaskInstances ?? []) {
 *   yield* Effect.log(`${task.TaskInstanceId}: ${task.Status}`);
 * }
 * ```
 */
export interface ListTaskInstances extends Binding.Service<
  ListTaskInstances,
  "AWS.MWAAServerless.ListTaskInstances",
  (
    workflow: Workflow,
  ) => Effect.Effect<
    (
      request: ListTaskInstancesInput,
    ) => Effect.Effect<
      mwaa.ListTaskInstancesResponse,
      mwaa.ListTaskInstancesError
    >
  >
> {}
export const ListTaskInstances = Binding.Service<ListTaskInstances>(
  "AWS.MWAAServerless.ListTaskInstances",
);

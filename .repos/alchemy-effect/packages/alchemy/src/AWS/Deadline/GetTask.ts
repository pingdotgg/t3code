import type * as deadline from "@distilled.cloud/aws/deadline";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Queue } from "./Queue.ts";

/**
 * Runtime binding for `deadline:GetTask`.
 *
 * Reads a task's detail for a step in the bound {@link Queue} — run status,
 * parameters, retry count, latest session action. The queue's
 * `farmId`/`queueId` are injected from the binding. Provide the
 * implementation with `Effect.provide(AWS.Deadline.GetTaskHttp)`.
 * @binding
 * @section Monitoring Tasks
 * @example Inspect A Task
 * ```typescript
 * // init — bind the operation to the queue
 * const getTask = yield* AWS.Deadline.GetTask(queue);
 *
 * // runtime
 * const task = yield* getTask({ jobId, stepId, taskId });
 * ```
 */
export interface GetTask extends Binding.Service<
  GetTask,
  "AWS.Deadline.GetTask",
  (
    queue: Queue,
  ) => Effect.Effect<
    (
      request: Omit<deadline.GetTaskRequest, "farmId" | "queueId">,
    ) => Effect.Effect<deadline.GetTaskResponse, deadline.GetTaskError>
  >
> {}
export const GetTask = Binding.Service<GetTask>("AWS.Deadline.GetTask");

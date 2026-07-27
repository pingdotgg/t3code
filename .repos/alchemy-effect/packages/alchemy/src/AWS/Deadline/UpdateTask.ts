import type * as deadline from "@distilled.cloud/aws/deadline";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Queue } from "./Queue.ts";

/**
 * Runtime binding for `deadline:UpdateTask`.
 *
 * Retargets a single task of a job in the bound {@link Queue} — requeue
 * (`READY`), cancel (`CANCELED`), suspend (`SUSPENDED`), or force-fail/
 * succeed it. The queue's `farmId`/`queueId` are injected from the binding.
 * Provide the implementation with `Effect.provide(AWS.Deadline.UpdateTaskHttp)`.
 * @binding
 * @section Managing Tasks
 * @example Cancel A Task
 * ```typescript
 * // init — bind the operation to the queue
 * const updateTask = yield* AWS.Deadline.UpdateTask(queue);
 *
 * // runtime
 * yield* updateTask({ jobId, stepId, taskId, targetRunStatus: "CANCELED" });
 * ```
 */
export interface UpdateTask extends Binding.Service<
  UpdateTask,
  "AWS.Deadline.UpdateTask",
  (
    queue: Queue,
  ) => Effect.Effect<
    (
      request: Omit<deadline.UpdateTaskRequest, "farmId" | "queueId">,
    ) => Effect.Effect<deadline.UpdateTaskResponse, deadline.UpdateTaskError>
  >
> {}
export const UpdateTask = Binding.Service<UpdateTask>(
  "AWS.Deadline.UpdateTask",
);

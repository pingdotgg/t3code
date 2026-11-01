import type * as cloudtasks from "@distilled.cloud/gcp/cloudtasks_v2";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { RuntimeContext } from "../../RuntimeContext.ts";
import type { Queue } from "./Queue.ts";

export interface CreateTaskRequest extends Omit<
  cloudtasks.CreateProjectsLocationsQueuesTasksRequest,
  "parent"
> {}

/**
 * Runtime binding for Cloud Tasks `queues.tasks.create`.
 *
 * Bind this operation to a {@link Queue} in a Function/Action init phase.
 * Provide {@link CreateTaskHttp}.
 *
 * ### Creating Tasks
 * **Example:** Enqueue an HTTP task
 * ```typescript
 * const createTask = yield* GCP.CloudTasks.CreateTask(queue);
 * yield* createTask({
 *   body: {
 *     task: {
 *       httpRequest: {
 *         url: "https://example.com/jobs",
 *         httpMethod: "POST",
 *         body: btoa(JSON.stringify({ id: "1" })),
 *       },
 *     },
 *   },
 * });
 * ```
 *
 * @binding
 * @category CloudTasks
 */
export interface CreateTask extends Binding.Service<
  CreateTask,
  "GCP.CloudTasks.CreateTask",
  (
    queue: Queue,
  ) => Effect.Effect<
    (
      request: CreateTaskRequest,
    ) => Effect.Effect<
      cloudtasks.Task,
      cloudtasks.CreateProjectsLocationsQueuesTasksError,
      RuntimeContext
    >
  >
> {}

export const CreateTask = Binding.Service<CreateTask>(
  "GCP.CloudTasks.CreateTask",
);

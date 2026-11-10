import * as cloudtasks from "@distilled.cloud/gcp/cloudtasks_v2";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as GCPBindings from "../GCPBindings.ts";
import { grantFor } from "../HttpBinding.ts";
import { CreateTask, type CreateTaskRequest } from "./CreateTask.ts";
import type { Queue } from "./Queue.ts";

/**
 * HTTP implementation of {@link CreateTask}.
 *
 * @layer
 * @provides GCP.CloudTasks.CreateTask
 */
export const CreateTaskHttp = Layer.effect(
  CreateTask,
  Effect.gen(function* () {
    const bind = yield* GCPBindings.Bind;
    const createTask = yield* GCPBindings.withCredentials(
      cloudtasks.createProjectsLocationsQueuesTasks,
    );
    return Effect.fn(function* (queue: Queue) {
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        yield* bind`GCP.CloudTasks.CreateTask(${queue})`({
          iam: [
            grantFor({ role: "roles/cloudtasks.enqueuer", on: "cloudtasks.queue" }, queue.name),
          ],
        });
      }
      const name = yield* queue.name;
      return Effect.fn(`GCP.CloudTasks.CreateTask(${queue.LogicalId})`)(function* (
        request: CreateTaskRequest,
      ) {
        return yield* createTask({
          ...request,
          parent: yield* name,
        });
      });
    });
  }),
);

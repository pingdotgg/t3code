import * as Cloudflare from "@alchemy.run/cloudflare";
import { Layer } from "effect";
import * as Effect from "effect/Effect";
import { HttpRouter } from "effect/http";
import * as HttpApi from "effect/http-api/HttpApi";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import * as HttpApiGroup from "effect/http-api/HttpApiGroup";
import * as Etag from "effect/http/Etag";
import * as HttpPlatform from "effect/http/HttpPlatform";
import * as Path from "effect/Path";
import { createTask, decodeTask, encodeTask, getTask, Task, TaskNotFound } from "./api.ts";

const HttpPlatformStub = Layer.succeed(HttpPlatform.HttpPlatform, {
  platform: "web",
  compression: {
    algorithms: new Set<HttpPlatform.CompressionAlgorithm>(),
    compressResponse: (response) => Effect.succeed(response),
  },
  fileResponse: () => Effect.die("HttpPlatform.fileResponse not supported"),
  fileWebResponse: () => Effect.die("HttpPlatform.fileWebResponse not supported"),
});

export class TasksDOGroup extends HttpApiGroup.make("TasksDO").add(getTask).add(createTask) {}

export class TaskDOApi extends HttpApi.make("TaskDOApi").add(TasksDOGroup) {}

/**
 * Durable Object backing the `createTaskDO` / `getTaskDO` endpoints.
 * Persists tasks in the DO's transactional storage and exposes simple
 * RPC methods that the Worker calls from its HttpApi handlers.
 */
export default class TasksObject extends Cloudflare.DurableObject<TasksObject>()(
  "TasksObject",
  Effect.gen(function* () {
    const state = yield* Cloudflare.DurableObjectState;

    return Effect.gen(function* () {
      const tasksGroup = HttpApiBuilder.group(TaskDOApi, "TasksDO", (handlers) =>
        handlers
          .handle("getTask", ({ params }) =>
            state.storage
              .get<Task>(params.id)
              .pipe(
                Effect.flatMap((task) =>
                  task
                    ? decodeTask(task).pipe(Effect.orDie)
                    : Effect.fail(new TaskNotFound({ id: params.id })),
                ),
              ),
          )
          .handle("createTask", ({ payload }) => {
            const id = crypto.randomUUID();
            const task = new Task({
              id,
              title: payload.title,
              completed: false,
            });
            return state.storage.put(id, encodeTask(task)).pipe(Effect.as(task));
          }),
      );

      return {
        fetch: HttpApiBuilder.layer(TaskDOApi).pipe(
          Layer.provide(tasksGroup),
          Layer.provide([Etag.layer, HttpPlatformStub, Path.layer]),
          HttpRouter.toHttpEffect,
        ),
      };
    });
  }),
) {}

import * as Cloudflare from "@/Cloudflare";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Etag from "effect/unstable/http/Etag";
import * as HttpPlatform from "effect/unstable/http/HttpPlatform";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";
import * as HttpApiClient from "effect/unstable/httpapi/HttpApiClient";
import { decodeTask, Task, TaskApi, TaskNotFound } from "./api.ts";
import TasksObject, { TaskDOApi } from "./object.ts";

const HttpPlatformStub = Layer.succeed(HttpPlatform.HttpPlatform, {
  fileResponse: () => Effect.die("HttpPlatform.fileResponse not supported"),
  fileWebResponse: () =>
    Effect.die("HttpPlatform.fileWebResponse not supported"),
});

const corsLayer = HttpRouter.cors({
  allowedOrigins: ["*"],
  allowedMethods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type"],
});

const Bucket = Cloudflare.R2.Bucket("Tasks");

export default class HttpApiTestWorker extends Cloudflare.Worker<HttpApiTestWorker>()(
  "HttpApiTestWorker",
  {
    main: import.meta.url,
  },
  Effect.gen(function* () {
    const tasks = yield* Cloudflare.R2.ReadWriteBucket(Bucket);
    const tasksDO = yield* TasksObject;

    const getTaskDO = (id: string = "default") =>
      HttpApiClient.makeWith(TaskDOApi, {
        baseUrl: `http://localhost`,
        httpClient: Cloudflare.toHttpClient(tasksDO.getByName(id)),
      });

    const tasksGroup = HttpApiBuilder.group(TaskApi, "Tasks", (handlers) =>
      handlers
        .handle("getTask", ({ params }) =>
          tasks.get(params.id).pipe(
            Effect.orDie,
            Effect.flatMap((data) =>
              data
                ? data.text().pipe(
                    Effect.map((data) => JSON.parse(data)),
                    Effect.orDie,
                  )
                : Effect.succeed(undefined),
            ),
            Effect.flatMap((data) =>
              data
                ? decodeTask(data).pipe(Effect.orDie)
                : Effect.fail(new TaskNotFound({ id: params.id })),
            ),
            Effect.tapError((err) => Effect.logError("err", err)),
          ),
        )
        .handle("createTask", ({ payload }) => {
          const task = new Task({
            id: crypto.randomUUID(),
            title: payload.title,
            completed: false,
          });
          return tasks
            .put(task.id, JSON.stringify(task))
            .pipe(Effect.orDie, Effect.as(task));
        })
        .handle("getTaskDO", ({ params }) =>
          getTaskDO().pipe(
            Effect.flatMap((client) =>
              client.TasksDO.getTask({ params }).pipe(Effect.orDie),
            ),
          ),
        )
        .handle("createTaskDO", ({ payload }) =>
          getTaskDO().pipe(
            Effect.flatMap((client) =>
              client.TasksDO.createTask({ payload }).pipe(Effect.orDie),
            ),
          ),
        ),
    );

    return {
      fetch: HttpApiBuilder.layer(TaskApi).pipe(
        Layer.provide(tasksGroup),
        Layer.provide([Etag.layer, HttpPlatformStub, Path.layer]),
        Layer.provide(corsLayer),
        HttpRouter.toHttpEffect,
      ),
    };
  }).pipe(Effect.provide(Cloudflare.R2.ReadWriteBucketBinding)),
) {}

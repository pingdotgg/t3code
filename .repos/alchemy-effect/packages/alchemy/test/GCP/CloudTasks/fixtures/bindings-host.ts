import * as GCP from "@/GCP";
import * as Effect from "effect/Effect";
import { serveProbes } from "../../bindingHost.ts";

/** Queue the binding is granted on (roles/cloudtasks.enqueuer). */
export const Jobs = GCP.CloudTasks.Queue("Jobs", { location: "us-central1" });

/** Target of the enqueued task; scheduled a day out so it never dispatches. */
export const TASK_URL = "https://example.com/alchemy-binding";

/**
 * Effect-native Cloud Run service exercising every Cloud Tasks binding as
 * its own runtime service account. Deployed from {@link ../Bindings.test.ts}.
 */
export default class CloudTasksBindingsHost extends GCP.Function<CloudTasksBindingsHost>()(
  "CloudTasksBindingsHost",
  { main: import.meta.url, invokerIamDisabled: true },
  Effect.gen(function* () {
    const createTask = yield* GCP.CloudTasks.CreateTask(Jobs);

    return {
      fetch: serveProbes({
        createTask: Effect.gen(function* () {
          const scheduleTime = yield* Effect.sync(() =>
            new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
          );
          return yield* createTask({
            body: {
              task: {
                scheduleTime,
                httpRequest: {
                  url: TASK_URL,
                  httpMethod: "POST",
                  body: btoa(JSON.stringify({ id: "1" })),
                },
              },
            },
          });
        }),
      }),
    };
  }).pipe(Effect.provide(GCP.CloudTasks.CreateTaskHttp)),
) {}

import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as we from "@distilled.cloud/gcp/workspaceevents_v1";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: GCP.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

// Push configs attach to an existing Workspace Events task; set
// GCP_TEST_WORKSPACE_EVENTS_TASK to run the lifecycle.
const runLifecycle = !!process.env.GCP_TEST_WORKSPACE_EVENTS_TASK;

const waitUntilGone = (name: string) =>
  we.getTasksPushNotificationConfigs({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider(
  "getTasksPushNotificationConfigs on a missing config fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        we.getTasksPushNotificationConfigs({
          name: "tasks/alchemy-missing-task/pushNotificationConfigs/alchemy-missing",
        }),
      );
      expect(error._tag).toEqual("TasksUnregisteredCaller");

      yield* stack.destroy();
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:workspaceevents", "live"],
    timeout: 90_000,
  },
);

test.provider.skipIf(runLifecycle)(
  "createTasksPushNotificationConfigs without access fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        we.createTasksPushNotificationConfigs({
          parent: "tasks/alchemy-missing-task",
          configId: "alchemy-probe",
          body: {
            pushNotificationConfig: {
              url: "https://example.com/workspace-events",
            },
          },
        }),
      );
      expect(error._tag).toEqual("NotFound");

      yield* stack.destroy();
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:workspaceevents", "live"],
    timeout: 90_000,
  },
);

test.provider.skipIf(!runLifecycle)(
  "create, replace, and delete a task push notification config",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const task = process.env.GCP_TEST_WORKSPACE_EVENTS_TASK ?? "";

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.WorkspaceEvents.TasksPushNotificationConfig(
            "Updates",
            {
              task,
              url: "https://example.com/workspace-events",
            },
          );
        }),
      );

      expect(created.name).toContain("/pushNotificationConfigs/");
      expect(created.configId.length).toBeGreaterThan(0);
      expect(created.url).toEqual("https://example.com/workspace-events");

      const fetched = yield* we.getTasksPushNotificationConfigs({
        name: created.name,
      });
      expect(fetched.name).toEqual(created.name);
      expect(fetched.pushNotificationConfig?.token).toContain("[alchemy ");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.WorkspaceEvents.TasksPushNotificationConfig(
            "Updates",
            {
              task,
              configId: created.configId,
              url: "https://example.com/workspace-events-v2",
            },
          );
        }),
      );

      expect(updated.configId).toEqual(created.configId);
      expect(updated.url).toEqual("https://example.com/workspace-events-v2");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:workspaceevents", "live"],
    timeout: 90_000,
  },
);

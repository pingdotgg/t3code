import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as cloudtasks from "@distilled.cloud/gcp/cloudtasks_v2";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: GCP.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const waitUntilGone = (name: string) =>
  cloudtasks.getProjectsLocationsQueues({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider(
  "create, update, and delete a queue",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.CloudTasks.Queue("Jobs", {
            location: "us-central1",
            rateLimits: {
              maxDispatchesPerSecond: 5,
              maxConcurrentDispatches: 3,
            },
            retryConfig: {
              maxAttempts: 3,
            },
          });
        }),
      );

      expect(created.name).toContain("/queues/");
      expect(created.queueId).toEqual(expect.any(String));
      expect(created.location).toEqual("us-central1");
      expect(created.state).toEqual("RUNNING");
      expect(created.retryConfig?.maxAttempts).toEqual(3);
      expect(created.rateLimits?.maxDispatchesPerSecond).toEqual(5);
      expect(created.rateLimits?.maxConcurrentDispatches).toEqual(3);

      const fetched = yield* cloudtasks.getProjectsLocationsQueues({
        name: created.name,
      });
      expect(fetched.name).toEqual(created.name);
      expect(fetched.retryConfig?.maxAttempts).toEqual(3);
      expect(fetched.rateLimits?.maxDispatchesPerSecond).toEqual(5);
      expect(fetched.httpTarget?.headerOverrides ?? []).toEqual([]);

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.CloudTasks.Queue("Jobs", {
            location: "us-central1",
            rateLimits: {
              maxDispatchesPerSecond: 8,
              maxConcurrentDispatches: 4,
            },
            retryConfig: {
              maxAttempts: 6,
            },
            stackdriverLoggingConfig: { samplingRatio: 1 },
            state: "PAUSED",
          });
        }),
      );

      expect(updated.name).toEqual(created.name);
      expect(updated.retryConfig?.maxAttempts).toEqual(6);
      expect(updated.rateLimits?.maxDispatchesPerSecond).toEqual(8);
      expect(updated.rateLimits?.maxConcurrentDispatches).toEqual(4);
      expect(updated.stackdriverLoggingConfig?.samplingRatio).toEqual(1);
      expect(updated.state).toEqual("PAUSED");

      const refetched = yield* cloudtasks.getProjectsLocationsQueues({
        name: created.name,
      });
      expect(refetched.retryConfig?.maxAttempts).toEqual(6);
      expect(refetched.rateLimits?.maxDispatchesPerSecond).toEqual(8);
      expect(refetched.stackdriverLoggingConfig?.samplingRatio).toEqual(1);
      expect(refetched.state).toEqual("PAUSED");

      const payload = yield* Effect.sync(() =>
        Buffer.from(JSON.stringify({ id: "1" }), "utf8").toString("base64"),
      );
      const task = yield* cloudtasks.createProjectsLocationsQueuesTasks({
        parent: created.name,
        body: {
          responseView: "FULL",
          task: {
            httpRequest: {
              url: "https://example.com/alchemy-cloudtasks-test",
              httpMethod: "POST",
              body: payload,
            },
          },
        },
      });
      expect(task.name).toContain("/tasks/");
      expect(task.httpRequest?.url).toEqual(
        "https://example.com/alchemy-cloudtasks-test",
      );

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:cloudtasks", "live"],
    timeout: 90_000,
  },
);

import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as pubsub from "@distilled.cloud/gcp/pubsub_v1";
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
  pubsub.getProjectsTopics({ topic: name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider(
  "create, update, and delete a topic",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.PubSub.Topic("Events", {
            labels: { env: "test" },
          });
        }),
      );

      expect(created.name).toContain("/topics/");
      expect(created.topicId).toEqual(expect.any(String));
      expect(created.labels).toMatchObject({ env: "test" });

      const fetched = yield* pubsub.getProjectsTopics({ topic: created.name });
      expect(fetched.name).toEqual(created.name);
      expect(fetched.labels?.env).toEqual("test");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.PubSub.Topic("Events", {
            topicId: created.topicId,
            labels: { env: "prod", role: "events" },
            messageRetentionDuration: "86400s",
          });
        }),
      );

      expect(updated.name).toEqual(created.name);
      expect(updated.labels).toMatchObject({ env: "prod", role: "events" });
      expect(updated.messageRetentionDuration).toEqual("86400s");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:pubsub", "live"], timeout: 120_000 },
);

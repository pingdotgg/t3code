import * as AWS from "@/AWS";
import { NotificationChannel } from "@/AWS/DevOpsGuru/NotificationChannel.ts";
import { Topic } from "@/AWS/SNS/Topic.ts";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Alchemy";
import * as devopsguru from "@distilled.cloud/aws/devops-guru";
import * as SNS from "@distilled.cloud/aws/sns";
import { expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";

const { test } = Test.make({ providers: AWS.providers() });

// Ungated typed-error probe: prove distilled returns a typed tag (never an
// untyped catch-all). A not-yet-onboarded account answers a bogus insight id
// with ResourceNotFoundException; once DevOps Guru has been onboarded the
// same request is rejected earlier as ValidationException — both are typed.
test.provider(
  "describeInsight on a nonexistent insight fails with a typed error",
  () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        devopsguru.describeInsight({
          Id: "alchemy-nonexistent-devopsguru-insight-probe",
        }),
      );
      expect(["ResourceNotFoundException", "ValidationException"]).toContain(
        error._tag,
      );
    }),
);

const listChannels = devopsguru.listNotificationChannels.items({}).pipe(
  Stream.runCollect,
  Effect.map((chunk) => Array.from(chunk)),
);

class TopicStillExists extends Data.TaggedError("TopicStillExists") {}

// Assert-gone for the SNS topic the test deploys alongside the channel:
// getTopicAttributes converges to the typed NotFoundException after destroy.
const assertTopicDeleted = Effect.fn(function* (topicArn: string) {
  yield* SNS.getTopicAttributes({ TopicArn: topicArn }).pipe(
    Effect.flatMap(() => Effect.fail(new TopicStillExists())),
    Effect.retry({
      while: (error) => error._tag === "TopicStillExists",
      schedule: Schedule.exponential(100),
      times: 8,
    }),
    Effect.catchTag("NotFoundException", () => Effect.void),
  );
});

test.provider(
  "lifecycle: add channel, converge filters, remove",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      // Create — an SNS topic and a channel with severity filters.
      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const topic = yield* Topic("Alerts", {});
          const channel = yield* NotificationChannel("Channel", {
            topicArn: topic.topicArn,
            severities: ["HIGH"],
          });
          return { topic, channel };
        }),
      );
      expect(created.channel.id).toBeDefined();
      expect(created.channel.topicArn).toBe(created.topic.topicArn);

      // Out-of-band verification via distilled.
      const observed = yield* listChannels;
      const live = observed.find((c) => c.Id === created.channel.id);
      expect(live?.Config?.Sns?.TopicArn).toBe(created.topic.topicArn);
      expect(live?.Config?.Filters?.Severities).toEqual(["HIGH"]);

      // Canonical list() coverage.
      const provider = yield* Provider.findProvider(NotificationChannel);
      const all = yield* provider.list();
      expect(all.some((c) => c.id === created.channel.id)).toBe(true);

      // Update — change the filters. The AWS config is immutable, so the
      // provider converges by remove + re-add (the channel id changes, the
      // topic stays put).
      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const topic = yield* Topic("Alerts", {});
          const channel = yield* NotificationChannel("Channel", {
            topicArn: topic.topicArn,
            severities: ["HIGH", "MEDIUM"],
            messageTypes: ["NEW_INSIGHT"],
          });
          return { topic, channel };
        }),
      );
      expect(updated.channel.topicArn).toBe(created.topic.topicArn);
      const afterUpdate = yield* listChannels;
      const liveUpdated = afterUpdate.find((c) => c.Id === updated.channel.id);
      expect(liveUpdated?.Config?.Sns?.TopicArn).toBe(created.topic.topicArn);
      expect(
        [...(liveUpdated?.Config?.Filters?.Severities ?? [])].sort(),
      ).toEqual(["HIGH", "MEDIUM"]);
      expect(liveUpdated?.Config?.Filters?.MessageTypes).toEqual([
        "NEW_INSIGHT",
      ]);
      // The old channel is gone (not duplicated).
      expect(
        afterUpdate.filter(
          (c) => c.Config?.Sns?.TopicArn === created.topic.topicArn,
        ),
      ).toHaveLength(1);

      // Idempotent redeploy — no drift, id is unchanged.
      const redeployed = yield* stack.deploy(
        Effect.gen(function* () {
          const topic = yield* Topic("Alerts", {});
          const channel = yield* NotificationChannel("Channel", {
            topicArn: topic.topicArn,
            severities: ["HIGH", "MEDIUM"],
            messageTypes: ["NEW_INSIGHT"],
          });
          return { topic, channel };
        }),
      );
      expect(redeployed.channel.id).toBe(updated.channel.id);

      // Destroy — the channel is removed and the SNS topic is gone.
      yield* stack.destroy();
      const afterDestroy = yield* listChannels;
      expect(
        afterDestroy.some(
          (c) => c.Config?.Sns?.TopicArn === created.topic.topicArn,
        ),
      ).toBe(false);
      yield* assertTopicDeleted(created.topic.topicArn);
    }),
  { timeout: 180_000 },
);

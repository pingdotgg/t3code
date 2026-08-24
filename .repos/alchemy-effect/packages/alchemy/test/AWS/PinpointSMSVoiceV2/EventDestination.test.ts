import * as AWS from "@/AWS";
import { ConfigurationSet, EventDestination } from "@/AWS/PinpointSMSVoiceV2";
import { Topic } from "@/AWS/SNS";
import * as Test from "@/Test/Alchemy";
import * as smsvoice from "@distilled.cloud/aws/pinpoint-sms-voice-v2";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: AWS.providers() });

const configSetName = "alchemy-test-smsvoice-event-dest-cs";

const getConfigSet = (name: string) =>
  smsvoice.describeConfigurationSets({ ConfigurationSetNames: [name] }).pipe(
    Effect.map((r) => r.ConfigurationSets?.[0]),
    Effect.catchTag("ResourceNotFoundException", () =>
      Effect.succeed(undefined),
    ),
  );

const assertConfigSetGone = (name: string) =>
  Effect.gen(function* () {
    const found = yield* getConfigSet(name);
    if (found !== undefined) {
      return yield* Effect.fail(
        new Error(`configuration set '${name}' still exists`),
      );
    }
  }).pipe(
    Effect.retry({
      schedule: Schedule.max([Schedule.fixed("3 seconds"), Schedule.recurs(8)]),
    }),
  );

// Configuration sets, SNS topics, and event destinations are all free and
// provision synchronously — the full lifecycle runs ungated.
test.provider(
  "create, update, and destroy an SNS event destination",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const program = (types: string[], enabled?: boolean) =>
        Effect.gen(function* () {
          // Grant End User Messaging SMS permission to publish events.
          const topic = yield* Topic("Events", {
            attributes: {
              Policy: JSON.stringify({
                Version: "2012-10-17",
                Statement: [
                  {
                    Effect: "Allow",
                    Principal: { Service: "sms-voice.amazonaws.com" },
                    Action: "sns:Publish",
                    Resource: "*",
                  },
                ],
              }),
            },
          });
          const configSet = yield* ConfigurationSet("Config", {
            configurationSetName: configSetName,
          });
          const destination = yield* EventDestination("Dest", {
            configurationSetName: configSet.configurationSetName,
            eventDestinationName: "alchemy-test-smsvoice-event-dest",
            matchingEventTypes: types,
            ...(enabled === undefined ? {} : { enabled }),
            snsDestination: { topicArn: topic.topicArn },
          });
          return { topic, configSet, destination };
        });

      // Create.
      const created = yield* stack.deploy(program(["ALL"]));
      expect(created.destination.configurationSetName).toBe(configSetName);
      expect(created.destination.eventDestinationName).toBe(
        "alchemy-test-smsvoice-event-dest",
      );
      expect(created.destination.enabled).toBe(true);
      expect(created.destination.matchingEventTypes).toEqual(["ALL"]);

      // Out-of-band verification via distilled.
      const observedSet = yield* getConfigSet(configSetName);
      const observed = observedSet?.EventDestinations?.find(
        (ed) => ed.EventDestinationName === "alchemy-test-smsvoice-event-dest",
      );
      expect(observed?.Enabled).toBe(true);
      expect([...(observed?.MatchingEventTypes ?? [])]).toEqual(["ALL"]);
      expect(observed?.SnsDestination?.TopicArn).toBe(created.topic.topicArn);

      // No-op redeploy keeps the same destination.
      const noop = yield* stack.deploy(program(["ALL"]));
      expect(noop.destination.configurationSetArn).toBe(
        created.destination.configurationSetArn,
      );

      // Update in place — narrow the event types and disable delivery.
      const updated = yield* stack.deploy(program(["TEXT_ALL"], false));
      expect(updated.destination.enabled).toBe(false);
      expect(updated.destination.matchingEventTypes).toEqual(["TEXT_ALL"]);
      const reobservedSet = yield* getConfigSet(configSetName);
      const reobserved = reobservedSet?.EventDestinations?.find(
        (ed) => ed.EventDestinationName === "alchemy-test-smsvoice-event-dest",
      );
      expect(reobserved?.Enabled).toBe(false);
      expect([...(reobserved?.MatchingEventTypes ?? [])]).toEqual(["TEXT_ALL"]);

      // Destroy and verify out-of-band with a typed wait-until-gone.
      yield* stack.destroy();
      yield* assertConfigSetGone(configSetName);
    }),
  { timeout: 240_000 },
);

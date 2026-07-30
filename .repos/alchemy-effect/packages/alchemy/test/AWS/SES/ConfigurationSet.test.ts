import * as AWS from "@/AWS";
import { ConfigurationSet, ConfigurationSetEventDestination } from "@/AWS/SES";
import { Topic } from "@/AWS/SNS";
import * as Test from "@/Test/Alchemy";
import * as sesv2 from "@distilled.cloud/aws/sesv2";
import { expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: AWS.providers() });

class ConfigurationSetStillExists extends Data.TaggedError(
  "ConfigurationSetStillExists",
)<{ readonly name: string }> {}

const assertConfigurationSetDeleted = (name: string) =>
  sesv2.getConfigurationSet({ ConfigurationSetName: name }).pipe(
    Effect.flatMap(() =>
      Effect.fail(new ConfigurationSetStillExists({ name })),
    ),
    Effect.catchTag("NotFoundException", () => Effect.void),
    Effect.retry({
      while: (e) => e._tag === "ConfigurationSetStillExists",
      schedule: Schedule.max([Schedule.exponential(500), Schedule.recurs(8)]),
    }),
  );

test.provider(
  "configuration set lifecycle: options, tags, no-op convergence",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const configSet = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* ConfigurationSet("LifecycleConfigSet", {
            reputationMetricsEnabled: true,
            tlsPolicy: "REQUIRE",
            maxDelivery: "1 hour",
            suppressedReasons: ["BOUNCE"],
            tags: { Environment: "test" },
          });
        }),
      );

      expect(configSet.configurationSetName).toBeDefined();
      expect(configSet.configurationSetArn).toContain(":configuration-set/");

      // out-of-band verification via distilled
      const observed = yield* sesv2.getConfigurationSet({
        ConfigurationSetName: configSet.configurationSetName,
      });
      expect(observed.ReputationOptions?.ReputationMetricsEnabled).toBe(true);
      expect(observed.DeliveryOptions?.TlsPolicy).toBe("REQUIRE");
      // Duration.Input prop converted to whole wire seconds
      expect(observed.DeliveryOptions?.MaxDeliverySeconds).toBe(3600);
      expect(observed.SuppressionOptions?.SuppressedReasons).toEqual([
        "BOUNCE",
      ]);
      const tags = Object.fromEntries(
        (observed.Tags ?? []).map((t) => [t.Key, t.Value]),
      );
      expect(tags.Environment).toBe("test");
      expect(tags["alchemy::id"]).toBe("LifecycleConfigSet");

      // sync options in place: disable sending, relax TLS, widen suppression
      yield* stack.deploy(
        Effect.gen(function* () {
          return yield* ConfigurationSet("LifecycleConfigSet", {
            sendingEnabled: false,
            reputationMetricsEnabled: false,
            tlsPolicy: "OPTIONAL",
            maxDelivery: "30 minutes",
            suppressedReasons: ["BOUNCE", "COMPLAINT"],
            tags: { Environment: "test", Extra: "1" },
          });
        }),
      );
      const updated = yield* sesv2.getConfigurationSet({
        ConfigurationSetName: configSet.configurationSetName,
      });
      expect(updated.SendingOptions?.SendingEnabled).toBe(false);
      expect(updated.ReputationOptions?.ReputationMetricsEnabled).toBe(false);
      expect(updated.DeliveryOptions?.TlsPolicy ?? "OPTIONAL").toBe("OPTIONAL");
      expect(updated.DeliveryOptions?.MaxDeliverySeconds).toBe(1800);
      expect(
        [...(updated.SuppressionOptions?.SuppressedReasons ?? [])].sort(),
      ).toEqual(["BOUNCE", "COMPLAINT"]);
      const updatedTags = Object.fromEntries(
        (updated.Tags ?? []).map((t) => [t.Key, t.Value]),
      );
      expect(updatedTags.Extra).toBe("1");

      yield* stack.destroy();
      yield* assertConfigurationSetDeleted(configSet.configurationSetName);
    }),
  { timeout: 120_000 },
);

test.provider(
  "custom name replaces on rename",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const first = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* ConfigurationSet("NamedConfigSet", {
            configurationSetName: "alchemy-test-ses-config-a",
          });
        }),
      );
      expect(first.configurationSetName).toBe("alchemy-test-ses-config-a");

      const second = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* ConfigurationSet("NamedConfigSet", {
            configurationSetName: "alchemy-test-ses-config-b",
          });
        }),
      );
      expect(second.configurationSetName).toBe("alchemy-test-ses-config-b");
      yield* assertConfigurationSetDeleted("alchemy-test-ses-config-a");

      yield* stack.destroy();
      yield* assertConfigurationSetDeleted("alchemy-test-ses-config-b");
    }),
  { timeout: 120_000 },
);

test.provider(
  "event destination lifecycle: SNS destination, update, delete",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { topic, configSet, destination } = yield* stack.deploy(
        Effect.gen(function* () {
          const topic = yield* Topic("SesEventsTopic", {});
          const configSet = yield* ConfigurationSet("EventsConfigSet", {});
          const destination = yield* ConfigurationSetEventDestination(
            "SnsDestination",
            {
              configurationSetName: configSet.configurationSetName,
              matchingEventTypes: ["SEND", "DELIVERY"],
              snsDestination: { topicArn: topic.topicArn },
            },
          );
          return { topic, configSet, destination };
        }),
      );

      expect(destination.eventDestinationName).toBeDefined();

      // out-of-band verification via distilled
      const observed = yield* sesv2.getConfigurationSetEventDestinations({
        ConfigurationSetName: configSet.configurationSetName,
      });
      const found = (observed.EventDestinations ?? []).find(
        (d) => d.Name === destination.eventDestinationName,
      );
      expect(found).toBeDefined();
      expect(found!.Enabled).toBe(true);
      expect([...found!.MatchingEventTypes].sort()).toEqual([
        "DELIVERY",
        "SEND",
      ]);
      expect(found!.SnsDestination?.TopicArn).toBe(topic.topicArn);

      // update event types + disable in place
      yield* stack.deploy(
        Effect.gen(function* () {
          const topic = yield* Topic("SesEventsTopic", {});
          const configSet = yield* ConfigurationSet("EventsConfigSet", {});
          const destination = yield* ConfigurationSetEventDestination(
            "SnsDestination",
            {
              configurationSetName: configSet.configurationSetName,
              enabled: false,
              matchingEventTypes: ["SEND", "DELIVERY", "BOUNCE", "COMPLAINT"],
              snsDestination: { topicArn: topic.topicArn },
            },
          );
          return { configSet, destination };
        }),
      );
      const updated = yield* sesv2.getConfigurationSetEventDestinations({
        ConfigurationSetName: configSet.configurationSetName,
      });
      const updatedFound = (updated.EventDestinations ?? []).find(
        (d) => d.Name === destination.eventDestinationName,
      );
      expect(updatedFound!.Enabled).toBe(false);
      expect(updatedFound!.MatchingEventTypes).toHaveLength(4);

      yield* stack.destroy();
      yield* assertConfigurationSetDeleted(configSet.configurationSetName);
    }),
  { timeout: 120_000 },
);

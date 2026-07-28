import * as AWS from "@/AWS";
import type { PolicyDocument } from "@/AWS/IAM/Policy.ts";
import { Role } from "@/AWS/IAM/Role.ts";
import {
  Destination,
  NotificationConfiguration,
} from "@/AWS/IoTManagedIntegrations";
import { Stream } from "@/AWS/Kinesis";
import { Region } from "@/AWS/Region.ts";
import * as Test from "@/Test/Alchemy";
import * as mi from "@distilled.cloud/aws/iot-managed-integrations";
import { expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: AWS.providers() });

// IoT Managed Integrations is only deployed in a few regions (eu-west-1,
// ca-central-1, ...). The testing profile's default region (us-west-2) has no
// endpoint, so the ungated probe pins a supported region explicitly. The
// gated lifecycle below requires an AWS profile whose region IS a supported
// one, e.g. a profile with region = eu-west-1.
const MI_REGION = "eu-west-1";
const pin = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.provideService(Region, Effect.succeed(MI_REGION)));

// Ungated typed-error probe: prove the distilled error union carries the
// not-found tag this provider's read/delete paths depend on.
test.provider(
  "getNotificationConfiguration on an unconfigured event type fails with ResourceNotFoundException",
  () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        pin(
          mi.getNotificationConfiguration({
            EventType: "CONNECTOR_ERROR_REPORT",
          }),
        ),
      );
      expect(error._tag).toBe("ResourceNotFoundException");
    }),
);

class ConfigurationStillExists extends Data.TaggedError(
  "ConfigurationStillExists",
)<{ readonly eventType: string }> {}

const assertConfigurationGone = (eventType: string) =>
  mi.getNotificationConfiguration({ EventType: eventType }).pipe(
    Effect.flatMap(() =>
      Effect.fail(new ConfigurationStillExists({ eventType })),
    ),
    Effect.catchTag("ResourceNotFoundException", () => Effect.void),
    Effect.retry({
      while: (e) => e._tag === "ConfigurationStillExists",
      schedule: Schedule.max([Schedule.exponential(500), Schedule.recurs(8)]),
    }),
  );

// Full lifecycle is gated: the service only exists in a few regions. Run with
// AWS_TEST_IOT_MI=1 and an AWS profile configured in a supported region.
test.provider.skipIf(!process.env.AWS_TEST_IOT_MI)(
  "create notification configuration, verify, retarget destination, destroy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const makeStack = (target: "A" | "B") =>
        Effect.gen(function* () {
          const stream = yield* Stream("Events", {});
          const assumeRolePolicyDocument: PolicyDocument = {
            Version: "2012-10-17",
            Statement: [
              {
                Effect: "Allow",
                Principal: {
                  Service: "iotmanagedintegrations.amazonaws.com",
                },
                Action: ["sts:AssumeRole"],
              },
            ],
          };
          const role = yield* Role("DeliveryRole", {
            assumeRolePolicyDocument,
            inlinePolicies: {
              kinesis: {
                Version: "2012-10-17",
                Statement: [
                  {
                    Effect: "Allow",
                    Action: ["kinesis:PutRecord", "kinesis:PutRecords"],
                    Resource: [stream.streamArn],
                  },
                ],
              },
            },
          });
          const destinationA = yield* Destination("DestinationA", {
            deliveryDestinationArn: stream.streamArn,
            roleArn: role.roleArn,
          });
          const destinationB = yield* Destination("DestinationB", {
            deliveryDestinationArn: stream.streamArn,
            roleArn: role.roleArn,
          });
          const routing = yield* NotificationConfiguration("Routing", {
            eventType: "DEVICE_LIFE_CYCLE",
            destinationName:
              target === "A"
                ? destinationA.destinationName
                : destinationB.destinationName,
            tags: { fixture: "iot-mi-notification-configuration" },
          });
          return { routing, destinationA, destinationB };
        });

      const { routing, destinationA } = yield* stack.deploy(makeStack("A"));

      expect(routing.eventType).toBe("DEVICE_LIFE_CYCLE");
      expect(routing.destinationName).toBe(destinationA.destinationName);
      expect(routing.tags.fixture).toBe("iot-mi-notification-configuration");

      // Out-of-band verification via distilled.
      const observed = yield* mi.getNotificationConfiguration({
        EventType: "DEVICE_LIFE_CYCLE",
      });
      expect(observed.DestinationName).toBe(destinationA.destinationName);
      expect(observed.Tags?.fixture).toBe("iot-mi-notification-configuration");

      // Retarget the configuration at destination B in place (no replace —
      // the event type is unchanged).
      const { routing: updated, destinationB } = yield* stack.deploy(
        makeStack("B"),
      );
      expect(updated.eventType).toBe("DEVICE_LIFE_CYCLE");
      expect(updated.destinationName).toBe(destinationB.destinationName);
      const retargeted = yield* mi.getNotificationConfiguration({
        EventType: "DEVICE_LIFE_CYCLE",
      });
      expect(retargeted.DestinationName).toBe(destinationB.destinationName);

      yield* stack.destroy();
      yield* assertConfigurationGone("DEVICE_LIFE_CYCLE");
    }),
  { timeout: 240_000 },
);

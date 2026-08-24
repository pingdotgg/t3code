import * as AWS from "@/AWS";
import type { PolicyDocument } from "@/AWS/IAM/Policy.ts";
import { Role } from "@/AWS/IAM/Role.ts";
import { Destination } from "@/AWS/IoTManagedIntegrations";
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
// endpoint, so the ungated probe pins a supported region explicitly. The gated
// lifecycle below requires an AWS profile whose region IS a supported one
// (SSO profiles resolve region from ~/.aws/config; the AWS_REGION env var is
// not consulted), e.g. a profile with region = eu-west-1.
const MI_REGION = "eu-west-1";
const pin = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.provideService(Region, Effect.succeed(MI_REGION)));

// Ungated typed-error probe: prove the distilled error union carries the
// not-found tag this provider's read/delete paths depend on.
test.provider(
  "getDestination on a nonexistent destination fails with ResourceNotFoundException",
  () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        pin(mi.getDestination({ Name: "alchemy-nonexistent-destination" })),
      );
      expect(error._tag).toBe("ResourceNotFoundException");
    }),
);

class DestinationStillExists extends Data.TaggedError(
  "DestinationStillExists",
)<{ readonly name: string }> {}

const assertDestinationGone = (name: string) =>
  mi.getDestination({ Name: name }).pipe(
    Effect.flatMap(() => Effect.fail(new DestinationStillExists({ name }))),
    Effect.catchTag("ResourceNotFoundException", () => Effect.void),
    Effect.retry({
      while: (e) => e._tag === "DestinationStillExists",
      schedule: Schedule.max([Schedule.exponential(500), Schedule.recurs(8)]),
    }),
  );

// Full lifecycle is gated: the service only exists in a few regions. Run with
// AWS_TEST_IOT_MI=1 and an AWS profile configured in a supported region.
test.provider.skipIf(!process.env.AWS_TEST_IOT_MI)(
  "create kinesis destination, verify, update description, destroy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const makeStack = (description: string) =>
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
          const destination = yield* Destination("EventDestination", {
            deliveryDestinationArn: stream.streamArn,
            roleArn: role.roleArn,
            description,
            tags: { fixture: "iot-mi-destination" },
          });
          return { destination };
        });

      const { destination } = yield* stack.deploy(makeStack("phase one"));

      expect(destination.destinationName).toBeDefined();
      expect(destination.deliveryDestinationType).toBe("KINESIS");
      expect(destination.description).toBe("phase one");

      // Out-of-band verification via distilled.
      const observed = yield* mi.getDestination({
        Name: destination.destinationName,
      });
      expect(observed.DeliveryDestinationArn).toBe(
        destination.deliveryDestinationArn,
      );
      expect(observed.Tags?.fixture).toBe("iot-mi-destination");

      // Update the description in place.
      const { destination: updated } = yield* stack.deploy(
        makeStack("phase two"),
      );
      expect(updated.destinationName).toBe(destination.destinationName);
      expect(updated.description).toBe("phase two");

      yield* stack.destroy();
      yield* assertDestinationGone(destination.destinationName);
    }),
  { timeout: 240_000 },
);

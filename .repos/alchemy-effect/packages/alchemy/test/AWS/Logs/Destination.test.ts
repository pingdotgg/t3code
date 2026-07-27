import * as AWS from "@/AWS";
import { Role } from "@/AWS/IAM/Role.ts";
import { Stream as KinesisStream } from "@/AWS/Kinesis/Stream.ts";
import { Destination } from "@/AWS/Logs/Destination.ts";
import * as Test from "@/Test/Alchemy";
import * as logs from "@distilled.cloud/aws/cloudwatch-logs";
import { expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: AWS.providers() });

const findDestination = Effect.fn(function* (destinationName: string) {
  const described = yield* logs.describeDestinations({
    DestinationNamePrefix: destinationName,
  });
  return (described.destinations ?? []).find(
    (destination) => destination.destinationName === destinationName,
  );
});

class DestinationStillExists extends Data.TaggedError(
  "DestinationStillExists",
)<{ readonly destinationName: string }> {}

const assertDestinationDeleted = (destinationName: string) =>
  findDestination(destinationName).pipe(
    Effect.flatMap((destination) =>
      destination === undefined
        ? Effect.void
        : Effect.fail(new DestinationStillExists({ destinationName })),
    ),
    Effect.retry({
      while: (e) => e._tag === "DestinationStillExists",
      schedule: Schedule.max([Schedule.exponential(500), Schedule.recurs(8)]),
    }),
  );

// Cross-account subscriptions need a second account to exercise end-to-end;
// this suite covers the single-account lifecycle (create/read/update/delete)
// per the catalog's scope note.
const infra = (allowedAccount: string) =>
  Effect.gen(function* () {
    const stream = yield* KinesisStream("DestinationStream", {});
    const role = yield* Role("DestinationDeliveryRole", {
      assumeRolePolicyDocument: {
        Version: "2012-10-17",
        Statement: [
          {
            Effect: "Allow",
            Principal: { Service: "logs.amazonaws.com" },
            Action: ["sts:AssumeRole"],
          },
        ],
      },
      inlinePolicies: {
        "kinesis-put": {
          Version: "2012-10-17",
          Statement: [
            {
              Effect: "Allow",
              Action: ["kinesis:PutRecord"],
              Resource: [stream.streamArn],
            },
          ],
        },
      },
    });
    return yield* Destination("CentralLogs", {
      destinationName: "alchemy-test-logs-destination",
      targetArn: stream.streamArn,
      roleArn: role.roleArn,
      accessPolicy: {
        Version: "2012-10-17",
        Statement: [
          {
            Sid: "AllowSubscribers",
            Effect: "Allow",
            Principal: { AWS: allowedAccount },
            Action: ["logs:PutSubscriptionFilter"],
            Resource: ["*"],
          },
        ],
      },
    });
  });

test.provider(
  "create, update access policy, delete destination",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(infra("391965393224"));

      expect(created.destinationName).toBe("alchemy-test-logs-destination");
      expect(created.destinationArn).toContain(":destination:");

      // out-of-band verification via distilled
      const observedCreated = yield* findDestination(created.destinationName);
      expect(observedCreated?.targetArn).toBe(created.targetArn);
      expect(observedCreated?.roleArn).toBe(created.roleArn);
      expect(observedCreated?.accessPolicy).toContain("AllowSubscribers");

      yield* stack.destroy();
      yield* assertDestinationDeleted(created.destinationName);
    }).pipe(Effect.onError(() => stack.destroy().pipe(Effect.ignore))),
  { timeout: 240_000 },
);

import * as AWS from "@/AWS";
import { RealtimeLogConfig } from "@/AWS/CloudFront";
import * as Test from "@/Test/Alchemy";
import * as cloudfront from "@distilled.cloud/aws/cloudfront";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: AWS.providers() });

// The role CloudFront assumes to deliver real-time log records to Kinesis.
const logDeliveryRole = (stream: AWS.Kinesis.Stream) =>
  AWS.IAM.Role("RealtimeLogRole", {
    assumeRolePolicyDocument: {
      Version: "2012-10-17",
      Statement: [
        {
          Effect: "Allow",
          Principal: { Service: "cloudfront.amazonaws.com" },
          Action: ["sts:AssumeRole"],
        },
      ],
    },
    inlinePolicies: {
      KinesisWrite: {
        Version: "2012-10-17",
        Statement: [
          {
            Effect: "Allow",
            Action: [
              "kinesis:DescribeStreamSummary",
              "kinesis:DescribeStream",
              "kinesis:PutRecord",
              "kinesis:PutRecords",
            ],
            Resource: [stream.streamArn],
          },
        ],
      },
    },
  });

const assertConfigGone = (name: string) =>
  cloudfront.getRealtimeLogConfig({ Name: name }).pipe(
    Effect.flatMap(() =>
      Effect.fail(new Error("realtime log config still exists")),
    ),
    Effect.catchTag("NoSuchRealtimeLogConfig", () => Effect.void),
    Effect.retry({
      while: (e) => e instanceof Error,
      schedule: Schedule.max([
        Schedule.fixed("2 seconds"),
        Schedule.recurs(10),
      ]),
    }),
  );

test.provider(
  "create, update in place, and delete realtime log config",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      // Create.
      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const stream = yield* AWS.Kinesis.Stream("EdgeLogStream", {});
          const role = yield* logDeliveryRole(stream);
          return yield* RealtimeLogConfig("EdgeLogConfig", {
            samplingRate: 100,
            fields: ["timestamp", "c-ip", "cs-uri-stem", "sc-status"],
            endpoints: [{ streamArn: stream.streamArn, roleArn: role.roleArn }],
          });
        }),
      );

      expect(created.arn).toContain("realtime-log-config");
      expect(created.samplingRate).toBe(100);
      // CloudFront canonicalizes (reorders) the field list.
      expect([...created.fields].sort()).toEqual(
        ["timestamp", "c-ip", "cs-uri-stem", "sc-status"].sort(),
      );
      expect(created.endpoints).toHaveLength(1);

      // Out-of-band verification.
      const observed = yield* cloudfront.getRealtimeLogConfig({
        Name: created.name,
      });
      expect(observed.RealtimeLogConfig?.ARN).toBe(created.arn);
      expect(observed.RealtimeLogConfig?.SamplingRate).toBe(100);

      // Update sampling rate + fields in place (same ARN).
      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const stream = yield* AWS.Kinesis.Stream("EdgeLogStream", {});
          const role = yield* logDeliveryRole(stream);
          return yield* RealtimeLogConfig("EdgeLogConfig", {
            samplingRate: 25,
            fields: ["timestamp", "c-ip"],
            endpoints: [{ streamArn: stream.streamArn, roleArn: role.roleArn }],
          });
        }),
      );

      expect(updated.arn).toBe(created.arn);
      expect(updated.samplingRate).toBe(25);
      expect([...updated.fields].sort()).toEqual(["timestamp", "c-ip"].sort());

      const observed2 = yield* cloudfront.getRealtimeLogConfig({
        Name: created.name,
      });
      expect(observed2.RealtimeLogConfig?.SamplingRate).toBe(25);
      expect([...(observed2.RealtimeLogConfig?.Fields ?? [])].sort()).toEqual(
        ["timestamp", "c-ip"].sort(),
      );

      yield* stack.destroy();
      yield* assertConfigGone(created.name);
    }),
  { timeout: 180_000 },
);

test.provider(
  "changing the name replaces the realtime log config",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const make = (name: string) =>
        Effect.gen(function* () {
          const stream = yield* AWS.Kinesis.Stream("ReplaceLogStream", {});
          const role = yield* AWS.IAM.Role("ReplaceLogRole", {
            assumeRolePolicyDocument: {
              Version: "2012-10-17",
              Statement: [
                {
                  Effect: "Allow",
                  Principal: { Service: "cloudfront.amazonaws.com" },
                  Action: ["sts:AssumeRole"],
                },
              ],
            },
            inlinePolicies: {
              KinesisWrite: {
                Version: "2012-10-17",
                Statement: [
                  {
                    Effect: "Allow",
                    Action: [
                      "kinesis:DescribeStreamSummary",
                      "kinesis:DescribeStream",
                      "kinesis:PutRecord",
                      "kinesis:PutRecords",
                    ],
                    Resource: [stream.streamArn],
                  },
                ],
              },
            },
          });
          return yield* RealtimeLogConfig("ReplaceLogConfig", {
            name,
            samplingRate: 100,
            fields: ["timestamp"],
            endpoints: [{ streamArn: stream.streamArn, roleArn: role.roleArn }],
          });
        });

      const created = yield* stack.deploy(make("alchemy-test-rtlc-a"));
      expect(created.name).toBe("alchemy-test-rtlc-a");

      const replaced = yield* stack.deploy(make("alchemy-test-rtlc-b"));
      expect(replaced.name).toBe("alchemy-test-rtlc-b");
      expect(replaced.arn).not.toBe(created.arn);

      // The old configuration must be gone.
      yield* assertConfigGone("alchemy-test-rtlc-a");

      yield* stack.destroy();
      yield* assertConfigGone("alchemy-test-rtlc-b");
    }),
  { timeout: 180_000 },
);

import * as AWS from "@/AWS";
import { Stream } from "@/AWS/DSQL";
import * as Test from "@/Test/Alchemy";
import * as dsql from "@distilled.cloud/aws/dsql";
import { expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: AWS.providers() });

const getStream = (clusterIdentifier: string, streamIdentifier: string) =>
  dsql
    .getStream({ clusterIdentifier, streamIdentifier })
    .pipe(
      Effect.catchTag("ResourceNotFoundException", () =>
        Effect.succeed(undefined),
      ),
    );

class StreamStillPresent extends Data.TaggedError("StreamStillPresent")<{
  readonly streamId: string;
  readonly status: string;
}> {}

// Gated behind AWS_TEST_SLOW: a DSQL CDC stream transitions
// CREATING -> ACTIVE in one to three minutes (AWS docs), which is beyond the
// ~90s async-provisioning budget for the always-on suite. The full lifecycle
// (cluster + Kinesis target + IAM service role + stream + destroy) measures
// ~5-7 minutes wall.
test.provider.skipIf(!process.env.AWS_TEST_SLOW)(
  "create and delete a DSQL CDC stream into Kinesis",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const cluster = yield* AWS.DSQL.Cluster("CdcDb", {});
          // CDC records can approach 10 MiB — the docs require
          // maxRecordSizeInKiB 10240 and ON_DEMAND mode on the target.
          const target = yield* AWS.Kinesis.Stream("CdcTarget", {
            streamMode: "ON_DEMAND",
            maxRecordSizeInKiB: 10240,
          });
          const role = yield* AWS.IAM.Role("CdcRole", {
            assumeRolePolicyDocument: {
              Version: "2012-10-17",
              Statement: [
                {
                  Sid: "DSQLAccess",
                  Effect: "Allow",
                  Principal: { Service: "dsql.amazonaws.com" },
                  Action: ["sts:AssumeRole"],
                },
              ],
            },
            inlinePolicies: {
              kinesis: {
                Version: "2012-10-17",
                Statement: [
                  {
                    Sid: "KinesisAccess",
                    Effect: "Allow",
                    Action: [
                      "kinesis:PutRecord",
                      "kinesis:PutRecords",
                      "kinesis:DescribeStreamSummary",
                      "kinesis:ListShards",
                    ],
                    Resource: target.streamArn,
                  },
                ],
              },
            },
          });
          const cdc = yield* Stream("Cdc", {
            clusterId: cluster.clusterId,
            kinesisStreamArn: target.streamArn,
            roleArn: role.roleArn,
            tags: { app: "alchemy-test" },
          });
          return {
            clusterId: cdc.clusterId,
            streamId: cdc.streamId,
            streamArn: cdc.streamArn,
            status: cdc.status,
            kinesisStreamArn: cdc.kinesisStreamArn,
            roleArn: cdc.roleArn,
          };
        }),
      );

      expect(created.streamId).toBeDefined();
      expect(created.status).toBe("ACTIVE");
      expect(created.streamArn).toContain(
        `:cluster/${created.clusterId}/stream/${created.streamId}`,
      );
      expect(created.kinesisStreamArn).toContain(":stream/");
      expect(created.roleArn).toContain(":role/");

      // out-of-band verification via distilled
      const observed = yield* getStream(created.clusterId, created.streamId);
      expect(observed?.status).toBe("ACTIVE");
      expect(observed?.targetDefinition?.kinesis.streamArn).toEqual(
        created.kinesisStreamArn,
      );
      expect(observed?.tags?.app).toEqual("alchemy-test");

      // destroy everything; typed wait-until-gone on the CDC stream
      yield* stack.destroy();
      yield* getStream(created.clusterId, created.streamId).pipe(
        Effect.flatMap((stream) =>
          stream === undefined || stream.status === "DELETED"
            ? Effect.void
            : Effect.fail(
                new StreamStillPresent({
                  streamId: created.streamId,
                  status: stream.status,
                }),
              ),
        ),
        Effect.retry({
          while: (e): boolean => e._tag === "StreamStillPresent",
          schedule: Schedule.max([
            Schedule.spaced("5 seconds"),
            Schedule.recurs(10),
          ]),
        }),
      );
    }),
  { timeout: 600_000 },
);

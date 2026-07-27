import { adopt } from "@/AdoptPolicy";
import * as AWS from "@/AWS";
import { Stream } from "@/AWS/Kinesis";
import * as Provider from "@/Provider";
import { State } from "@/State";
import * as Test from "@/Test/Alchemy";
import * as Kinesis from "@distilled.cloud/aws/kinesis";
import { describe, expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: AWS.providers() });

describe.skipIf(!!process.env.FAST)("AWS.Kinesis.Stream", () => {
  test.provider(
    "create and delete stream with default props",
    (stack) =>
      Effect.gen(function* () {
        const stream = yield* stack.deploy(
          Effect.gen(function* () {
            return yield* Stream("DefaultStream");
          }),
        );

        expect(stream.streamName).toBeDefined();
        expect(stream.streamArn).toBeDefined();
        expect(stream.streamStatus).toEqual("ACTIVE");

        const streamDescription = yield* Kinesis.describeStreamSummary({
          StreamName: stream.streamName,
        });
        expect(streamDescription.StreamDescriptionSummary.StreamStatus).toEqual(
          "ACTIVE",
        );
        expect(
          streamDescription.StreamDescriptionSummary.StreamModeDetails
            ?.StreamMode,
        ).toEqual("ON_DEMAND");

        yield* stack.destroy();

        yield* assertStreamDeleted(stream.streamName);
      }),
    { timeout: 180_000 },
  );

  test.provider(
    "create, update, delete on-demand stream with tags",
    (stack) =>
      Effect.gen(function* () {
        const stream = yield* stack.deploy(
          Effect.gen(function* () {
            return yield* Stream("TestStream", {
              streamMode: "ON_DEMAND",
              tags: { Environment: "test" },
            });
          }),
        );

        // Verify the stream was created
        const streamDescription = yield* Kinesis.describeStreamSummary({
          StreamName: stream.streamName,
        });
        expect(streamDescription.StreamDescriptionSummary.StreamStatus).toEqual(
          "ACTIVE",
        );
        expect(
          streamDescription.StreamDescriptionSummary.StreamModeDetails
            ?.StreamMode,
        ).toEqual("ON_DEMAND");
        expect(
          streamDescription.StreamDescriptionSummary.RetentionPeriodHours,
        ).toEqual(24);

        // Verify tags
        const tagging = yield* Kinesis.listTagsForStream({
          StreamName: stream.streamName,
        });
        expect(tagging.Tags).toContainEqual({
          Key: "Environment",
          Value: "test",
        });

        // Update the stream - increase retention period and update tags
        yield* stack.deploy(
          Effect.gen(function* () {
            return yield* Stream("TestStream", {
              streamMode: "ON_DEMAND",
              retentionPeriod: "48 hours",
              tags: { Environment: "production", Team: "platform" },
            });
          }),
        );

        // Verify the retention period was updated
        const updatedDescription = yield* Kinesis.describeStreamSummary({
          StreamName: stream.streamName,
        });
        expect(
          updatedDescription.StreamDescriptionSummary.RetentionPeriodHours,
        ).toEqual(48);

        // Verify tags were updated
        const updatedTagging = yield* Kinesis.listTagsForStream({
          StreamName: stream.streamName,
        });
        expect(updatedTagging.Tags).toContainEqual({
          Key: "Environment",
          Value: "production",
        });
        expect(updatedTagging.Tags).toContainEqual({
          Key: "Team",
          Value: "platform",
        });

        yield* stack.destroy();

        yield* assertStreamDeleted(stream.streamName);
      }),
    { timeout: 180_000 },
  );

  test.provider(
    "create provisioned stream with shards",
    (stack) =>
      Effect.gen(function* () {
        const stream = yield* stack.deploy(
          Effect.gen(function* () {
            return yield* Stream("ProvisionedStream", {
              streamMode: "PROVISIONED",
              shardCount: 2,
            });
          }),
        );

        // Verify the stream was created with shards
        const streamDescription = yield* Kinesis.describeStreamSummary({
          StreamName: stream.streamName,
        });
        expect(streamDescription.StreamDescriptionSummary.StreamStatus).toEqual(
          "ACTIVE",
        );
        expect(
          streamDescription.StreamDescriptionSummary.StreamModeDetails
            ?.StreamMode,
        ).toEqual("PROVISIONED");
        expect(
          streamDescription.StreamDescriptionSummary.OpenShardCount,
        ).toEqual(2);

        yield* stack.destroy();

        yield* assertStreamDeleted(stream.streamName);
      }),
    { timeout: 180_000 },
  );

  test.provider(
    "update provisioned stream shard count",
    (stack) =>
      Effect.gen(function* () {
        const stream = yield* stack.deploy(
          Effect.gen(function* () {
            return yield* Stream("ShardStream", {
              streamMode: "PROVISIONED",
              shardCount: 1,
            });
          }),
        );

        // Verify initial shard count
        const streamDescription = yield* Kinesis.describeStreamSummary({
          StreamName: stream.streamName,
        });
        expect(
          streamDescription.StreamDescriptionSummary.OpenShardCount,
        ).toEqual(1);

        // Update shard count
        yield* stack.deploy(
          Effect.gen(function* () {
            return yield* Stream("ShardStream", {
              streamMode: "PROVISIONED",
              shardCount: 2,
            });
          }),
        );

        // Verify shard count was updated
        const updatedDescription = yield* Kinesis.describeStreamSummary({
          StreamName: stream.streamName,
        });
        expect(
          updatedDescription.StreamDescriptionSummary.OpenShardCount,
        ).toEqual(2);

        yield* stack.destroy();

        yield* assertStreamDeleted(stream.streamName);
      }),
    { timeout: 300_000 },
  );

  test.provider(
    "create stream with custom name",
    (stack) =>
      Effect.gen(function* () {
        const customName = `test-custom-kinesis-stream-custom-name-stream`;

        const stream = yield* stack.deploy(
          Effect.gen(function* () {
            return yield* Stream("CustomNameStream", {
              streamName: customName,
            });
          }),
        );

        expect(stream.streamName).toEqual(customName);
        expect(stream.streamArn).toContain(customName);

        // Verify the stream exists
        const streamDescription = yield* Kinesis.describeStreamSummary({
          StreamName: customName,
        });
        expect(streamDescription.StreamDescriptionSummary.StreamName).toEqual(
          customName,
        );

        yield* stack.destroy();

        yield* assertStreamDeleted(customName);
      }),
    { timeout: 180_000 },
  );

  test.provider(
    "create stream with encryption",
    (stack) =>
      Effect.gen(function* () {
        const stream = yield* stack.deploy(
          Effect.gen(function* () {
            return yield* Stream("EncryptedStream", {
              encryption: true,
            });
          }),
        );

        // Verify the stream has encryption enabled
        const streamDescription = yield* Kinesis.describeStreamSummary({
          StreamName: stream.streamName,
        });
        expect(
          streamDescription.StreamDescriptionSummary.EncryptionType,
        ).toEqual("KMS");

        // Update to disable encryption
        yield* stack.deploy(
          Effect.gen(function* () {
            return yield* Stream("EncryptedStream", {
              encryption: false,
            });
          }),
        );

        // Verify encryption is disabled
        const updatedDescription = yield* Kinesis.describeStreamSummary({
          StreamName: stream.streamName,
        });
        expect(
          updatedDescription.StreamDescriptionSummary.EncryptionType,
        ).toEqual("NONE");

        yield* stack.destroy();

        yield* assertStreamDeleted(stream.streamName);
      }),
    { timeout: 180_000 },
  );

  test.provider(
    "create stream with enhanced monitoring and update metrics",
    (stack) =>
      Effect.gen(function* () {
        const stream = yield* stack.deploy(
          Effect.gen(function* () {
            return yield* Stream("MonitoredStream", {
              shardLevelMetrics: ["IncomingBytes", "OutgoingRecords"],
            });
          }),
        );

        // Verify enhanced monitoring is enabled
        const streamDescription = yield* Kinesis.describeStreamSummary({
          StreamName: stream.streamName,
        });
        const metrics =
          streamDescription.StreamDescriptionSummary.EnhancedMonitoring?.[0]
            ?.ShardLevelMetrics ?? [];
        expect(metrics).toContain("IncomingBytes");
        expect(metrics).toContain("OutgoingRecords");

        // Update metrics - add some, remove some
        yield* stack.deploy(
          Effect.gen(function* () {
            return yield* Stream("MonitoredStream", {
              shardLevelMetrics: [
                "IncomingBytes",
                "IncomingRecords",
                "IteratorAgeMilliseconds",
              ],
            });
          }),
        );

        // Verify metrics were updated
        const updatedDescription = yield* Kinesis.describeStreamSummary({
          StreamName: stream.streamName,
        });
        const updatedMetrics =
          updatedDescription.StreamDescriptionSummary.EnhancedMonitoring?.[0]
            ?.ShardLevelMetrics ?? [];
        expect(updatedMetrics).toContain("IncomingBytes");
        expect(updatedMetrics).toContain("IncomingRecords");
        expect(updatedMetrics).toContain("IteratorAgeMilliseconds");
        expect(updatedMetrics).not.toContain("OutgoingRecords");

        yield* stack.destroy();

        yield* assertStreamDeleted(stream.streamName);
      }),
    { timeout: 180_000 },
  );

  test.provider(
    "idempotent create - stream already exists",
    (stack) =>
      Effect.gen(function* () {
        // First create
        const stream1 = yield* stack.deploy(
          Effect.gen(function* () {
            return yield* Stream("IdempotentStream", {});
          }),
        );
        const streamName = stream1.streamName;

        // Second create (should be idempotent)
        const stream2 = yield* stack.deploy(
          Effect.gen(function* () {
            return yield* Stream("IdempotentStream", {});
          }),
        );
        expect(stream2.streamName).toEqual(streamName);

        yield* stack.destroy();

        yield* assertStreamDeleted(streamName);
      }),
    { timeout: 180_000 },
  );

  test.provider(
    "switch stream mode from provisioned to on-demand",
    (stack) =>
      Effect.gen(function* () {
        const stream = yield* stack.deploy(
          Effect.gen(function* () {
            return yield* Stream("ModeChangeStream", {
              streamMode: "PROVISIONED",
              shardCount: 1,
            });
          }),
        );

        // Verify provisioned mode
        const streamDescription = yield* Kinesis.describeStreamSummary({
          StreamName: stream.streamName,
        });
        expect(
          streamDescription.StreamDescriptionSummary.StreamModeDetails
            ?.StreamMode,
        ).toEqual("PROVISIONED");

        // Update to on-demand mode
        yield* stack.deploy(
          Effect.gen(function* () {
            return yield* Stream("ModeChangeStream", {
              streamMode: "ON_DEMAND",
            });
          }),
        );

        // Verify on-demand mode
        const updatedDescription = yield* Kinesis.describeStreamSummary({
          StreamName: stream.streamName,
        });
        expect(
          updatedDescription.StreamDescriptionSummary.StreamModeDetails
            ?.StreamMode,
        ).toEqual("ON_DEMAND");

        yield* stack.destroy();

        yield* assertStreamDeleted(stream.streamName);
      }),
    { timeout: 300_000 },
  );

  test.provider(
    "decrease retention period",
    (stack) =>
      Effect.gen(function* () {
        const stream = yield* stack.deploy(
          Effect.gen(function* () {
            return yield* Stream("RetentionStream", {
              retentionPeriod: "48 hours",
            });
          }),
        );

        // Verify initial retention period
        const streamDescription = yield* Kinesis.describeStreamSummary({
          StreamName: stream.streamName,
        });
        expect(
          streamDescription.StreamDescriptionSummary.RetentionPeriodHours,
        ).toEqual(48);

        // Decrease retention period back to default
        yield* stack.deploy(
          Effect.gen(function* () {
            return yield* Stream("RetentionStream", {
              retentionPeriod: "24 hours",
            });
          }),
        );

        // Verify retention period was decreased
        const updatedDescription = yield* Kinesis.describeStreamSummary({
          StreamName: stream.streamName,
        });
        expect(
          updatedDescription.StreamDescriptionSummary.RetentionPeriodHours,
        ).toEqual(24);

        yield* stack.destroy();

        yield* assertStreamDeleted(stream.streamName);
      }),
    { timeout: 180_000 },
  );

  test.provider(
    "update stream resource policy and max record size",
    (stack) =>
      Effect.gen(function* () {
        const stream = yield* stack.deploy(
          Effect.gen(function* () {
            return yield* Stream("PolicyStream", {
              streamMode: "PROVISIONED",
              shardCount: 1,
            });
          }),
        );

        const policy = JSON.stringify({
          Version: "2012-10-17",
          Statement: [
            {
              Sid: "AllowSameAccountDescribe",
              Effect: "Allow",
              Principal: {
                AWS: `arn:aws:iam::${stream.streamArn.split(":")[4]}:root`,
              },
              Action: ["kinesis:DescribeStreamSummary"],
              Resource: stream.streamArn,
            },
          ],
        });

        const updated = yield* stack.deploy(
          Effect.gen(function* () {
            return yield* Stream("PolicyStream", {
              streamMode: "PROVISIONED",
              shardCount: 1,
              resourcePolicy: policy,
              maxRecordSizeInKiB: 2048,
            });
          }),
        );

        expect(updated.resourcePolicy).toContain("AllowSameAccountDescribe");
        expect(updated.maxRecordSizeInKiB).toEqual(2048);

        const policyResponse = yield* Kinesis.getResourcePolicy({
          ResourceARN: stream.streamArn,
        });
        expect(policyResponse.Policy).toContain("AllowSameAccountDescribe");

        const summary = yield* Kinesis.describeStreamSummary({
          StreamName: stream.streamName,
        });
        expect(summary.StreamDescriptionSummary.MaxRecordSizeInKiB).toEqual(
          2048,
        );

        yield* stack.destroy();
        yield* assertStreamDeleted(stream.streamName);
      }),
    { timeout: 240_000 },
  );

  test.provider(
    "update warm throughput when account supports it",
    (stack) =>
      Effect.gen(function* () {
        const accountSettings = yield* Kinesis.describeAccountSettings({});
        const status =
          accountSettings.MinimumThroughputBillingCommitment?.Status ??
          "DISABLED";

        if (status === "DISABLED") {
          return;
        }

        const stream = yield* stack.deploy(
          Effect.gen(function* () {
            return yield* Stream("WarmThroughputStream");
          }),
        );

        const updated = yield* stack.deploy(
          Effect.gen(function* () {
            return yield* Stream("WarmThroughputStream", {
              warmThroughputMiBps: 10,
            });
          }),
        );

        expect(updated.warmThroughput?.targetMiBps).toEqual(10);

        const summary = yield* Kinesis.describeStreamSummary({
          StreamName: stream.streamName,
        });
        expect(
          summary.StreamDescriptionSummary.WarmThroughput?.TargetMiBps,
        ).toEqual(10);

        yield* stack.destroy();
        yield* assertStreamDeleted(stream.streamName);
      }),
    { timeout: 240_000 },
  );

  test.provider(
    "owned stream (matching alchemy tags) is silently adopted without --adopt",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();

        // Deterministic name so a previously-killed run's orphan is reclaimed
        // by the pre-clean below instead of leaking forever.
        const streamName = "alchemy-test-kinesis-adopt";

        // Idempotent pre-clean: reclaim any leftover from an interrupted run.
        yield* deleteStreamIfExists(streamName);
        yield* assertStreamDeleted(streamName);

        // The state wipe below detaches the stream from the scratch stack, so
        // a crash in that window would orphan it — guarantee deletion.
        yield* Effect.gen(function* () {
          const initial = yield* stack.deploy(
            Effect.gen(function* () {
              return yield* Stream("AdoptableStream", { streamName });
            }),
          );
          expect(initial.streamName).toEqual(streamName);

          // Wipe state — the stream stays in Kinesis.
          yield* Effect.gen(function* () {
            const state = yield* yield* State;
            yield* state.delete({
              stack: stack.name,
              stage: "test",
              fqn: "AdoptableStream",
            });
          }).pipe(Effect.provide(stack.state));

          const adopted = yield* stack.deploy(
            Effect.gen(function* () {
              return yield* Stream("AdoptableStream", { streamName });
            }),
          );

          expect(adopted.streamArn).toEqual(initial.streamArn);

          yield* stack.destroy();
          yield* assertStreamDeleted(streamName);
        }).pipe(Effect.ensuring(deleteStreamIfExists(streamName)));
      }),
    { timeout: 240_000 },
  );

  test.provider(
    "foreign-tagged stream requires adopt(true) to take over",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();

        // Deterministic name so a previously-killed run's orphan is reclaimed
        // by the pre-clean below instead of leaking forever.
        const streamName = "alchemy-test-kinesis-takeover";

        // Idempotent pre-clean: reclaim any leftover from an interrupted run.
        yield* deleteStreamIfExists(streamName);
        yield* assertStreamDeleted(streamName);

        // The state wipe below detaches the stream from the scratch stack, so
        // a crash in that window would orphan it — guarantee deletion.
        yield* Effect.gen(function* () {
          yield* stack.deploy(
            Effect.gen(function* () {
              return yield* Stream("Original", { streamName });
            }),
          );

          yield* Effect.gen(function* () {
            const state = yield* yield* State;
            yield* state.delete({
              stack: stack.name,
              stage: "test",
              fqn: "Original",
            });
          }).pipe(Effect.provide(stack.state));

          const takenOver = yield* stack
            .deploy(
              Effect.gen(function* () {
                return yield* Stream("Different", { streamName });
              }),
            )
            .pipe(adopt(true));

          expect(takenOver.streamName).toEqual(streamName);

          const tagsResp = yield* Kinesis.listTagsForResource({
            ResourceARN: takenOver.streamArn,
          });
          const tagMap = Object.fromEntries(
            (tagsResp.Tags ?? [])
              .filter(
                (t): t is { Key: string; Value: string } =>
                  typeof t.Value === "string",
              )
              .map((t) => [t.Key, t.Value]),
          );
          expect(tagMap["alchemy::id"]).toEqual("Different");

          yield* stack.destroy();
          yield* assertStreamDeleted(streamName);
        }).pipe(Effect.ensuring(deleteStreamIfExists(streamName)));
      }),
    { timeout: 240_000 },
  );

  // Canonical `list()` test (AWS account/region-scoped collection): deploy a
  // real stream, resolve the typed provider via `Provider.findProvider`, call
  // `list()`, and assert the deployed stream appears in the exhaustively-
  // paginated, fully-hydrated result.
  test.provider(
    "list enumerates the deployed stream",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();

        const stream = yield* stack.deploy(
          Effect.gen(function* () {
            return yield* Stream("ListStream", {
              streamName: "alchemy-test-kinesis-stream-list",
              tags: { Environment: "test" },
            });
          }),
        );

        const provider = yield* Provider.findProvider(Stream);
        const all = yield* provider.list();

        const found = all.find((s) => s.streamName === stream.streamName);
        expect(found).toBeDefined();
        // The hydrated element must match the full `read` Attributes shape.
        expect(found?.streamArn).toEqual(stream.streamArn);
        expect(found?.streamStatus).toEqual("ACTIVE");
        expect(found?.tags?.Environment).toEqual("test");

        yield* stack.destroy();

        yield* assertStreamDeleted(stream.streamName);
      }),
    { timeout: 240_000 },
  );

  // Idempotent out-of-band delete: safe when the stream never existed or was
  // already deleted (tolerates ResourceNotFoundException), retries the
  // transient in-use/limit errors, and dies loudly on anything else so a
  // cleanup failure is never silent. Error channel is `never` so it can be
  // used as an `Effect.ensuring` finalizer.
  const deleteStreamIfExists = Effect.fn(function* (streamName: string) {
    yield* Kinesis.deleteStream({
      StreamName: streamName,
      EnforceConsumerDeletion: true,
    }).pipe(
      Effect.retry({
        while: (e) =>
          e._tag === "ResourceInUseException" ||
          e._tag === "LimitExceededException",
        schedule: Schedule.spaced("5 seconds"),
        times: 8,
      }),
      Effect.catchTag("ResourceNotFoundException", () => Effect.void),
      Effect.orDie,
    );
  });

  class StreamStillExists extends Data.TaggedError("StreamStillExists") {}

  const assertStreamDeleted = Effect.fn(function* (streamName: string) {
    yield* Kinesis.describeStreamSummary({
      StreamName: streamName,
    }).pipe(
      Effect.flatMap(() => Effect.fail(new StreamStillExists())),
      Effect.retry({
        while: (e: { _tag: string }) =>
          e._tag === "StreamStillExists" ||
          // During stream deletion, AWS may return incomplete responses that fail parsing
          e._tag === "ParseError",
        schedule: Schedule.max([Schedule.exponential(500), Schedule.recurs(8)]),
      }),
      Effect.catchTag("ResourceNotFoundException", () => Effect.void),
    );
  });
});

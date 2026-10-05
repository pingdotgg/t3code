import * as AWS from "@/AWS";
import * as Core from "@/Test/Core";
import * as Test from "@/Test/Alchemy";
import * as EC2 from "@distilled.cloud/aws/ec2";
import * as ECS from "@distilled.cloud/aws/ecs";
import * as S3 from "@distilled.cloud/aws/s3";
import * as SQS from "@distilled.cloud/aws/sqs";
import { describe, expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import ServerEventTask, {
  ACKNOWLEDGED_PREFIX,
  artifactKey,
  INCOMING_PREFIX,
  INCOMING_SUFFIX,
  PROCESSED_PREFIX,
  RECEIVED_PREFIX,
  ServerEventBucket,
} from "./fixtures/server-event-source-task.ts";

const testOptions = {
  providers: AWS.providers(),
  dev: false,
  stage: `${Core.defaultStage()}_s3_server_events`,
};
const { test, beforeAll, afterAll } = Test.make(testOptions);
const stackName = "S3ServerEventSource";
const stack = Core.scratchStack(
  testOptions,
  stackName,
  "test/AWS/S3/ServerEventSource.test.ts",
);

interface Deployment {
  bucketName: string;
  bucketArn: string;
  clusterArn: string;
  serviceName: string;
  taskDefinitionArn: string;
}

let deployed: Deployment | undefined;
let queueUrl: string | undefined;

// Cold Docker/ECR/Fargate startup can exceed 120s; opt in with warm build
// caches and an existing public default VPC. There is no ALB or HTTP probe.
describe.skipIf(!process.env.AWS_TEST_SLOW || !!process.env.FAST).concurrent(
  "S3 Server/SQS event source on ECS",
  {
    tags: [
      "provider:aws",
      "provider:aws:ec2",
      "provider:aws:ecs",
      "provider:aws:s3",
      "provider:aws:sqs",
      "live",
    ],
  },
  () => {
    beforeAll(Core.withProviders(stack.destroy(), testOptions, stackName), {
      timeout: 120_000,
    });
    beforeAll(
      Core.withProviders(
        Effect.gen(function* () {
          const network = yield* EC2.describeVpcs({
            Filters: [{ Name: "is-default", Values: ["true"] }],
          });
          const vpc = network.Vpcs?.find((candidate) => candidate.IsDefault);
          if (!vpc?.VpcId) {
            return yield* Effect.fail(
              new Error(
                "Server event acceptance requires an existing default VPC",
              ),
            );
          }
          const vpcId = AWS.EC2.VpcId(vpc.VpcId);
          const subnets = yield* EC2.describeSubnets({
            Filters: [
              { Name: "vpc-id", Values: [vpcId] },
              { Name: "default-for-az", Values: ["true"] },
              { Name: "state", Values: ["available"] },
            ],
          });
          const subnetIds = (subnets.Subnets ?? [])
            .flatMap((subnet) => (subnet.SubnetId ? [subnet.SubnetId] : []))
            .sort();
          if (subnetIds.length === 0) {
            return yield* Effect.fail(
              new Error(
                "Server event acceptance requires an available public default subnet",
              ),
            );
          }

          deployed = yield* stack.deploy(
            Effect.gen(function* () {
              const bucket = yield* ServerEventBucket;
              const cluster = yield* AWS.ECS.Cluster("S3ServerEventCluster");
              const securityGroup = yield* AWS.EC2.SecurityGroup(
                "S3ServerEventSecurityGroup",
                {
                  vpcId,
                  description:
                    "S3 notification consumer with outbound access only",
                  ingress: [],
                  egress: [{ ipProtocol: "-1", cidrIpv4: "0.0.0.0/0" }],
                },
              );
              const task = yield* ServerEventTask;
              const service = yield* AWS.ECS.Service("S3ServerEventService", {
                cluster,
                task: {
                  taskDefinitionArn: task.taskDefinitionArn,
                  containerName: task.containerName,
                  port: task.port,
                },
                desiredCount: 1,
                loadBalancer: false,
                vpcId,
                subnets: [subnetIds[0]!],
                securityGroups: [securityGroup.groupId],
                assignPublicIp: true,
                deploymentStabilizationTimeout: "90 seconds",
              });
              return {
                bucketName: bucket.bucketName,
                bucketArn: bucket.bucketArn,
                clusterArn: cluster.clusterArn,
                serviceName: service.serviceName,
                taskDefinitionArn: task.taskDefinitionArn,
              };
            }),
          );

          const notifications = yield* S3.getBucketNotificationConfiguration({
            Bucket: deployed.bucketName,
          });
          expect(notifications.QueueConfigurations).toHaveLength(1);
          const queueArn = notifications.QueueConfigurations![0]!.QueueArn;
          const queueName = queueArn.split(":").at(-1)!;
          const queue = yield* SQS.getQueueUrl({ QueueName: queueName });
          expect(queue.QueueUrl).toBeTruthy();
          queueUrl = queue.QueueUrl!;
        }),
        testOptions,
        stackName,
      ),
      { timeout: 120_000 },
    );

    afterAll(
      Core.withProviders(
        Effect.gen(function* () {
          yield* stack.destroy();
          if (deployed) {
            yield* S3.headBucket({ Bucket: deployed.bucketName }).pipe(
              Effect.flatMap(() =>
                Effect.fail(
                  new FixtureResourceStillExists({ resource: "bucket" }),
                ),
              ),
              Effect.retry({
                while: (error) => error._tag === "FixtureResourceStillExists",
                schedule: Schedule.spaced("4 seconds"),
                times: 9,
              }),
              Effect.catchTag("NotFound", () => Effect.void),
              Effect.timeout("45 seconds"),
            );
            const clusters = yield* ECS.describeClusters({
              clusters: [deployed.clusterArn],
            });
            expect(
              (clusters.clusters ?? []).filter(
                (cluster) => cluster.status !== "INACTIVE",
              ),
            ).toEqual([]);
          }
          if (queueUrl) {
            yield* SQS.getQueueAttributes({
              QueueUrl: queueUrl,
              AttributeNames: ["QueueArn"],
            }).pipe(
              Effect.flatMap(() =>
                Effect.fail(
                  new FixtureResourceStillExists({ resource: "queue" }),
                ),
              ),
              Effect.retry({
                while: (error) => error._tag === "FixtureResourceStillExists",
                schedule: Schedule.spaced("4 seconds"),
                times: 9,
              }),
              Effect.catchTag("QueueDoesNotExist", () => Effect.void),
              Effect.timeout("45 seconds"),
            );
          }
        }),
        testOptions,
        stackName,
      ),
      { timeout: 120_000 },
    );

    test.provider(
      "deploys an ECS consumer with an S3 principal and both notification filters",
      () =>
        Effect.gen(function* () {
          const fixture = deployed!;
          const result = yield* ECS.describeServices({
            cluster: fixture.clusterArn,
            services: [fixture.serviceName],
          });
          expect(result.failures ?? []).toEqual([]);
          expect(result.services).toHaveLength(1);
          const service = result.services![0]!;
          expect(service.taskDefinition).toBe(fixture.taskDefinitionArn);
          expect(service.runningCount).toBe(1);
          expect(service.pendingCount).toBe(0);
          expect(service.loadBalancers ?? []).toEqual([]);

          const notifications = yield* S3.getBucketNotificationConfiguration({
            Bucket: fixture.bucketName,
          });
          expect(notifications.QueueConfigurations).toHaveLength(1);
          expect(notifications.LambdaFunctionConfigurations ?? []).toEqual([]);
          const configuration = notifications.QueueConfigurations![0]!;
          expect(configuration.Events).toEqual([
            "s3:ObjectCreated:*",
            "s3:ObjectRemoved:*",
          ]);
          expect(
            configuration.Filter?.Key?.FilterRules?.map((rule) => ({
              ...rule,
              Name: rule.Name?.toLowerCase(),
            })),
          ).toEqual([
            { Name: "prefix", Value: INCOMING_PREFIX },
            { Name: "suffix", Value: INCOMING_SUFFIX },
          ]);

          const attributes = yield* SQS.getQueueAttributes({
            QueueUrl: queueUrl!,
            AttributeNames: ["Policy", "QueueArn"],
          });
          expect(attributes.Attributes?.QueueArn).toBe(configuration.QueueArn);
          const policy = yield* Effect.try(() =>
            JSON.parse(attributes.Attributes!.Policy!),
          );
          expect(policy).toEqual({
            Version: "2012-10-17",
            Statement: [
              {
                Sid: "AllowS3EventsFromServerEventBucket",
                Effect: "Allow",
                Principal: { Service: "s3.amazonaws.com" },
                Action: "sqs:SendMessage",
                Resource: configuration.QueueArn,
                Condition: {
                  ArnEquals: { "aws:SourceArn": fixture.bucketArn },
                },
              },
            ],
          });
        }),
      { timeout: 120_000 },
    );

    test.provider(
      "records exact overwritten versions, delete markers, and version deletions through SQS",
      () =>
        Effect.gen(function* () {
          const Bucket = deployed!.bucketName;
          const key = `${INCOMING_PREFIX}versions/space + percent% question? hash# 雪${INCOMING_SUFFIX}`;
          const first = yield* S3.putObject({
            Bucket,
            Key: key,
            Body: "first version",
          });
          const second = yield* S3.putObject({
            Bucket,
            Key: key,
            Body: "second version",
          });
          expect(first.VersionId).toBeTruthy();
          expect(second.VersionId).toBeTruthy();
          expect(first.VersionId).not.toBe(second.VersionId);

          const created = yield* waitForArtifacts([
            {
              key,
              eventName: "s3:ObjectCreated:Put",
              versionId: first.VersionId!,
            },
            {
              key,
              eventName: "s3:ObjectCreated:Put",
              versionId: second.VersionId!,
            },
          ]);
          expect(created.map((record) => record.content)).toEqual([
            "first version",
            "second version",
          ]);
          expect(created.map((record) => record.readVersionId)).toEqual([
            first.VersionId,
            second.VersionId,
          ]);
          expect(created[0]!.size).toBe("first version".length);
          expect(created[1]!.size).toBe("second version".length);
          expect(created.every((record) => !!record.eTag)).toBe(true);
          expect(created[0]!.sequencer).not.toBe(created[1]!.sequencer);

          const marker = yield* S3.deleteObject({ Bucket, Key: key });
          expect(marker.DeleteMarker).toBe(true);
          expect(marker.VersionId).toBeTruthy();
          const deleted = yield* S3.deleteObject({
            Bucket,
            Key: key,
            VersionId: first.VersionId!,
          });
          expect(deleted.VersionId).toBe(first.VersionId);
          const removed = yield* waitForArtifacts([
            {
              key,
              eventName: "s3:ObjectRemoved:DeleteMarkerCreated",
              versionId: marker.VersionId!,
            },
            {
              key,
              eventName: "s3:ObjectRemoved:Delete",
              versionId: first.VersionId!,
            },
          ]);
          expect(removed.every((record) => record.content === undefined)).toBe(
            true,
          );
          expect(
            removed.every((record) => record.readVersionId === undefined),
          ).toBe(true);

          const versions = yield* S3.listObjectVersions({
            Bucket,
            Prefix: key,
          });
          expect(
            (versions.Versions ?? []).map((version) => version.VersionId),
          ).toEqual([second.VersionId]);
          expect(versions.DeleteMarkers).toHaveLength(1);
          expect(versions.DeleteMarkers![0]!.VersionId).toBe(marker.VersionId);
          expect(versions.DeleteMarkers![0]!.IsLatest).toBe(true);

          yield* assertArtifactCount(key, 4);
        }),
      { timeout: 120_000 },
    );

    test.provider(
      "records Copy notifications with the exact source and destination versions",
      () =>
        Effect.gen(function* () {
          const Bucket = deployed!.bucketName;
          const sourceKey = `copy-source/space + percent% 雪${INCOMING_SUFFIX}`;
          const key = `${INCOMING_PREFIX}copy/exact version + 雪${INCOMING_SUFFIX}`;
          const content = "copied version: 雪 + %";
          const source = yield* S3.putObject({
            Bucket,
            Key: sourceKey,
            Body: content,
          });
          expect(source.VersionId).toBeTruthy();
          yield* S3.putObject({
            Bucket,
            Key: sourceKey,
            Body: "newer source",
          });
          const CopySource = yield* Effect.sync(
            () =>
              `${Bucket}/${encodeURIComponent(sourceKey)}?versionId=${encodeURIComponent(source.VersionId!)}`,
          );
          const copied = yield* S3.copyObject({
            Bucket,
            Key: key,
            CopySource,
          });
          expect(copied.CopySourceVersionId).toBe(source.VersionId);
          expect(copied.VersionId).toBeTruthy();
          const overwritten = yield* S3.putObject({
            Bucket,
            Key: key,
            Body: "newer destination",
          });
          expect(overwritten.VersionId).not.toBe(copied.VersionId);
          const records = yield* waitForArtifacts([
            {
              key,
              eventName: "s3:ObjectCreated:Copy",
              versionId: copied.VersionId!,
            },
            {
              key,
              eventName: "s3:ObjectCreated:Put",
              versionId: overwritten.VersionId!,
            },
          ]);
          yield* assertCreation(
            records[0]!,
            content,
            copied.VersionId!,
            copied.CopyObjectResult?.ETag,
          );
          yield* assertCreation(
            records[1]!,
            "newer destination",
            overwritten.VersionId!,
            overwritten.ETag,
          );
          yield* assertArtifactCount(key, 2);
          yield* assertArtifactCount(sourceKey, 0);
        }),
      { timeout: 120_000 },
    );

    test.provider(
      "records completed multipart notifications with the exact version and content",
      () =>
        Effect.gen(function* () {
          const Bucket = deployed!.bucketName;
          const key = `${INCOMING_PREFIX}multipart/completed + 雪${INCOMING_SUFFIX}`;
          const content = "completed multipart version: 雪 + %";
          const upload = yield* S3.createMultipartUpload({
            Bucket,
            Key: key,
          });
          expect(upload.UploadId).toBeTruthy();
          const UploadId = upload.UploadId!;
          yield* Effect.gen(function* () {
            // A single final part may be smaller than S3's 5 MiB minimum.
            const part = yield* S3.uploadPart({
              Bucket,
              Key: key,
              UploadId,
              PartNumber: 1,
              Body: content,
            });
            expect(part.ETag).toBeTruthy();
            yield* assertArtifactCount(key, 0);
            const completed = yield* S3.completeMultipartUpload({
              Bucket,
              Key: key,
              UploadId,
              MultipartUpload: {
                Parts: [{ PartNumber: 1, ETag: part.ETag! }],
              },
            });
            expect(completed.VersionId).toBeTruthy();
            const overwritten = yield* S3.putObject({
              Bucket,
              Key: key,
              Body: "after multipart",
            });
            expect(overwritten.VersionId).not.toBe(completed.VersionId);
            const records = yield* waitForArtifacts([
              {
                key,
                eventName: "s3:ObjectCreated:CompleteMultipartUpload",
                versionId: completed.VersionId!,
              },
              {
                key,
                eventName: "s3:ObjectCreated:Put",
                versionId: overwritten.VersionId!,
              },
            ]);
            yield* assertCreation(
              records[0]!,
              content,
              completed.VersionId!,
              completed.ETag,
            );
            yield* assertCreation(
              records[1]!,
              "after multipart",
              overwritten.VersionId!,
              overwritten.ETag,
            );
            yield* assertArtifactCount(key, 2);
          }).pipe(
            Effect.ensuring(
              S3.abortMultipartUpload({ Bucket, Key: key, UploadId }).pipe(
                Effect.catchTag("NoSuchUpload", () => Effect.void),
                Effect.orDie,
              ),
            ),
          );
        }),
      { timeout: 120_000 },
    );

    test.provider(
      "records explicit delete-marker deletion and restores the previous data version",
      () =>
        Effect.gen(function* () {
          const Bucket = deployed!.bucketName;
          const key = `${INCOMING_PREFIX}marker/restore${INCOMING_SUFFIX}`;
          const content = "restored after marker deletion";
          const source = yield* S3.putObject({
            Bucket,
            Key: key,
            Body: content,
          });
          expect(source.VersionId).toBeTruthy();
          const marker = yield* S3.deleteObject({ Bucket, Key: key });
          expect(marker.DeleteMarker).toBe(true);
          expect(marker.VersionId).toBeTruthy();
          const deleted = yield* S3.deleteObject({
            Bucket,
            Key: key,
            VersionId: marker.VersionId!,
          });
          expect(deleted.DeleteMarker).toBe(true);
          expect(deleted.VersionId).toBe(marker.VersionId);
          const records = yield* waitForArtifacts([
            {
              key,
              eventName: "s3:ObjectCreated:Put",
              versionId: source.VersionId!,
            },
            {
              key,
              eventName: "s3:ObjectRemoved:DeleteMarkerCreated",
              versionId: marker.VersionId!,
            },
            {
              key,
              eventName: "s3:ObjectRemoved:Delete",
              versionId: marker.VersionId!,
            },
          ]);
          yield* assertCreation(
            records[0]!,
            content,
            source.VersionId!,
            source.ETag,
          );
          for (const record of records.slice(1)) {
            expect(record.content).toBeUndefined();
            expect(record.readVersionId).toBeUndefined();
          }
          const versions = yield* S3.listObjectVersions({
            Bucket,
            Prefix: key,
          });
          expect(versions.IsTruncated).toBe(false);
          expect(versions.DeleteMarkers ?? []).toEqual([]);
          expect(versions.Versions).toHaveLength(1);
          expect(versions.Versions![0]!.VersionId).toBe(source.VersionId);
          expect(versions.Versions![0]!.IsLatest).toBe(true);
          const restored = yield* S3.getObject({ Bucket, Key: key });
          expect(restored.VersionId).toBe(source.VersionId);
          expect(
            yield* Stream.mkString(Stream.decodeText(restored.Body!)),
          ).toBe(content);
          yield* assertArtifactCount(key, 3);
        }),
      { timeout: 120_000 },
    );

    test.provider(
      "acknowledges duplicate real creation payloads after source deletion without rewriting durable evidence",
      () =>
        Effect.gen(function* () {
          const Bucket = deployed!.bucketName;
          const key = `${INCOMING_PREFIX}replay/deleted + percent% 雪${INCOMING_SUFFIX}`;
          const content = "durable content after source deletion";
          const source = yield* S3.putObject({
            Bucket,
            Key: key,
            Body: content,
          });
          expect(source.VersionId).toBeTruthy();
          const identity = {
            key,
            eventName: "s3:ObjectCreated:Put",
            versionId: source.VersionId!,
          };
          const [original] = yield* waitForArtifacts([identity]);
          yield* assertCreation(
            original!,
            content,
            source.VersionId!,
            source.ETag,
          );
          const delivery = yield* findDelivery(identity);
          yield* waitForAcknowledgements([delivery.messageId]);
          const Key = yield* Effect.sync(() =>
            artifactKey(key, identity.eventName, identity.versionId),
          );
          const before = yield* S3.headObject({ Bucket, Key });
          expect(before.VersionId).toBeTruthy();

          yield* S3.deleteObject({
            Bucket,
            Key: key,
            VersionId: source.VersionId!,
          });
          yield* waitForArtifacts([
            {
              key,
              eventName: "s3:ObjectRemoved:Delete",
              versionId: source.VersionId!,
            },
          ]);
          const missing = yield* S3.getObject({
            Bucket,
            Key: key,
            VersionId: source.VersionId!,
          }).pipe(
            Effect.flatMap(({ Body }) => Stream.runDrain(Body!)),
            Effect.as(false),
            Effect.catchTag("NoSuchVersion", () => Effect.succeed(true)),
          );
          expect(missing).toBe(true);

          const replay = yield* SQS.sendMessageBatch({
            QueueUrl: queueUrl!,
            Entries: [
              { Id: "duplicate-one", MessageBody: delivery.body },
              { Id: "duplicate-two", MessageBody: delivery.body },
            ],
          });
          expect(replay.Failed ?? []).toEqual([]);
          expect(replay.Successful).toHaveLength(2);
          yield* waitForAcknowledgements(
            replay.Successful!.map((entry) => entry.MessageId),
          );
          const after = yield* S3.headObject({ Bucket, Key });
          expect(after.VersionId).toBe(before.VersionId);
          expect(after.ETag).toBe(before.ETag);
          const [durable] = yield* waitForArtifacts([identity]);
          expect(durable).toEqual(original);
          const versions = yield* S3.listObjectVersions({
            Bucket,
            Prefix: Key,
          });
          expect(versions.IsTruncated).toBe(false);
          expect(versions.Versions).toHaveLength(1);
          expect(versions.Versions![0]!.VersionId).toBe(before.VersionId);
          yield* assertArtifactCount(key, 2);
        }),
      { timeout: 120_000 },
    );

    test.provider(
      "ignores and acknowledges an S3 TestEvent before processing a later genuine notification",
      () =>
        Effect.gen(function* () {
          const Bucket = deployed!.bucketName;
          const key = `${INCOMING_PREFIX}test-event/later-genuine${INCOMING_SUFFIX}`;
          const configuration = yield* S3.getBucketNotificationConfiguration({
            Bucket,
          });
          yield* S3.putBucketNotificationConfiguration({
            Bucket,
            NotificationConfiguration: configuration,
          });
          const delivery = yield* findDelivery("s3:TestEvent").pipe(
            Effect.retry({
              while: (error) => error instanceof DeliveryNotReady,
              schedule: Schedule.spaced("2 seconds"),
              times: 9,
            }),
            Effect.timeout("45 seconds"),
          );
          yield* waitForAcknowledgements([delivery.messageId]);
          const body = delivery.body;
          const sent = yield* SQS.sendMessage({
            QueueUrl: queueUrl!,
            MessageBody: body,
          });
          expect(sent.MessageId).toBeTruthy();
          yield* waitForAcknowledgements([sent.MessageId!]);
          const observed = yield* readEvidence(
            `${RECEIVED_PREFIX}${sent.MessageId!}.json`,
          );
          expect(observed).toBe(body);
          yield* assertArtifactCount(key, 0);

          const content = "genuine delivery after TestEvent acknowledgement";
          const source = yield* S3.putObject({
            Bucket,
            Key: key,
            Body: content,
          });
          expect(source.VersionId).toBeTruthy();
          const [record] = yield* waitForArtifacts([
            {
              key,
              eventName: "s3:ObjectCreated:Put",
              versionId: source.VersionId!,
            },
          ]);
          yield* assertCreation(
            record!,
            content,
            source.VersionId!,
            source.ETag,
          );
          yield* assertArtifactCount(key, 1);
        }),
      { timeout: 120_000 },
    );

    test.provider(
      "excludes creations and removals that miss either the prefix or the suffix",
      () =>
        Effect.gen(function* () {
          const Bucket = deployed!.bucketName;
          const excludedKeys = [
            `outside/${INCOMING_PREFIX}filters/prefix${INCOMING_SUFFIX}`,
            `${INCOMING_PREFIX}filters/suffix${INCOMING_SUFFIX}.bin`,
            `${INCOMING_PREFIX}filters/case.TXT`,
          ];
          for (const Key of excludedKeys) {
            const source = yield* S3.putObject({
              Bucket,
              Key,
              Body: "not subscribed",
            });
            expect(source.VersionId).toBeTruthy();
            const marker = yield* S3.deleteObject({ Bucket, Key });
            expect(marker.DeleteMarker).toBe(true);
            yield* S3.deleteObject({
              Bucket,
              Key,
              VersionId: source.VersionId!,
            });
          }
          const key = `${INCOMING_PREFIX}filters/positive-control${INCOMING_SUFFIX}`;
          const source = yield* S3.putObject({
            Bucket,
            Key: key,
            Body: "subscribed",
          });
          const marker = yield* S3.deleteObject({ Bucket, Key: key });
          expect(source.VersionId).toBeTruthy();
          expect(marker.DeleteMarker).toBe(true);
          expect(marker.VersionId).toBeTruthy();
          yield* waitForArtifacts([
            {
              key,
              eventName: "s3:ObjectCreated:Put",
              versionId: source.VersionId!,
            },
            {
              key,
              eventName: "s3:ObjectRemoved:DeleteMarkerCreated",
              versionId: marker.VersionId!,
            },
          ]);
          // Check a bounded quiet window after the positive control arrives.
          yield* Effect.forEach(excludedKeys, (excludedKey) =>
            assertArtifactCount(excludedKey, 0),
          ).pipe(
            Effect.repeat({
              schedule: Schedule.spaced("2 seconds"),
              times: 4,
            }),
          );
          yield* assertArtifactCount(key, 2);
        }),
      { timeout: 120_000 },
    );
  },
);

interface NotificationIdentity {
  key: string;
  eventName: string;
  versionId: string;
}

const artifactSchema = Schema.Struct({
  bucket: Schema.String,
  key: Schema.String,
  eventName: Schema.String,
  versionId: Schema.String,
  sequencer: Schema.String,
  size: Schema.optional(Schema.Number),
  eTag: Schema.optional(Schema.String),
  content: Schema.optional(Schema.String),
  readVersionId: Schema.optional(Schema.String),
});

const assertCreation = Effect.fn(function* (
  record: typeof artifactSchema.Type,
  content: string,
  versionId: string,
  eTag: string | undefined,
) {
  expect(record.content).toBe(content);
  expect(record.readVersionId).toBe(versionId);
  const size = yield* Effect.sync(
    () => new TextEncoder().encode(content).byteLength,
  );
  expect(record.size).toBe(size);
  expect(eTag).toBeTruthy();
  expect(record.eTag).toBe(eTag!.replace(/^"|"$/g, ""));
});

const assertArtifactCount = Effect.fn(function* (key: string, count: number) {
  const Prefix = yield* Effect.sync(
    () => `${PROCESSED_PREFIX}${encodeURIComponent(key)}/`,
  );
  const artifacts = yield* S3.listObjectsV2({
    Bucket: deployed!.bucketName,
    Prefix,
  });
  expect(artifacts.IsTruncated).toBe(false);
  expect(artifacts.Contents ?? []).toHaveLength(count);
});

const readEvidence = Effect.fn(function* (Key: string) {
  const object = yield* S3.getObject({
    Bucket: deployed!.bucketName,
    Key,
  }).pipe(
    Effect.catchTag("NoSuchKey", () =>
      Effect.fail(new EvidenceNotReady({ key: Key })),
    ),
    Effect.retry({
      while: (error) => error._tag === "EvidenceNotReady",
      schedule: Schedule.spaced("2 seconds"),
      times: 9,
    }),
  );
  return yield* Stream.mkString(Stream.decodeText(object.Body!));
});

const waitForAcknowledgements = (messageIds: string[]) =>
  Effect.forEach(
    messageIds,
    (messageId) =>
      readEvidence(`${ACKNOWLEDGED_PREFIX}${messageId}.json`).pipe(
        Effect.tap((body) => Effect.sync(() => expect(body).toBe("{}"))),
      ),
    { concurrency: 2 },
  ).pipe(Effect.timeout("25 seconds"));

const deliverySchema = Schema.fromJsonString(
  Schema.Struct({
    Event: Schema.optional(Schema.String),
    Service: Schema.optional(Schema.String),
    Bucket: Schema.optional(Schema.String),
    Records: Schema.optional(
      Schema.Array(
        Schema.Struct({
          eventName: Schema.String,
          s3: Schema.Struct({
            bucket: Schema.Struct({ name: Schema.String }),
            object: Schema.Struct({
              key: Schema.String,
              versionId: Schema.optional(Schema.String),
            }),
          }),
        }),
      ),
    ),
  }),
);

const findDelivery = Effect.fn(function* (
  identity: NotificationIdentity | "s3:TestEvent",
) {
  const deliveries = yield* S3.listObjectsV2({
    Bucket: deployed!.bucketName,
    Prefix: RECEIVED_PREFIX,
  });
  expect(deliveries.IsTruncated).toBe(false);
  for (const delivery of deliveries.Contents ?? []) {
    const body = yield* readEvidence(delivery.Key!);
    const payload = yield* Schema.decodeUnknownEffect(deliverySchema)(body);
    const matches = yield* Effect.sync(() =>
      identity === "s3:TestEvent"
        ? payload.Event === identity &&
          payload.Service === "Amazon S3" &&
          payload.Bucket === deployed!.bucketName &&
          payload.Records === undefined
        : (payload.Records ?? []).some(
            (record) =>
              record.s3.bucket.name === deployed!.bucketName &&
              decodeURIComponent(record.s3.object.key.replace(/\+/g, " ")) ===
                identity.key &&
              record.s3.object.versionId === identity.versionId &&
              `s3:${record.eventName.replace(/^s3:/, "")}` ===
                identity.eventName,
          ),
    );
    if (matches) {
      return {
        messageId: delivery.Key!.slice(RECEIVED_PREFIX.length, -".json".length),
        body,
      };
    }
  }
  return yield* Effect.fail(
    new DeliveryNotReady({
      eventName: identity === "s3:TestEvent" ? identity : identity.eventName,
    }),
  );
});

const readArtifact = Effect.fn(function* (identity: NotificationIdentity) {
  const Key = yield* Effect.sync(() =>
    artifactKey(identity.key, identity.eventName, identity.versionId),
  );
  const object = yield* S3.getObject({
    Bucket: deployed!.bucketName,
    Key,
  }).pipe(
    Effect.catchTag("NoSuchKey", () =>
      Effect.fail(new ArtifactNotReady(identity)),
    ),
    Effect.retry({
      while: (error) => error._tag === "ArtifactNotReady",
      schedule: Schedule.spaced("4 seconds"),
      times: 9,
    }),
  );
  const body = yield* Stream.mkString(Stream.decodeText(object.Body!));
  const record = yield* Effect.try(() => JSON.parse(body)).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(artifactSchema)),
  );
  expect(record.bucket).toBe(deployed!.bucketName);
  expect(record.key).toBe(identity.key);
  expect(record.eventName).toBe(identity.eventName);
  expect(record.versionId).toBe(identity.versionId);
  expect(record.sequencer).toMatch(/^[0-9a-f]+$/i);
  return record;
});

const waitForArtifacts = (identities: NotificationIdentity[]) =>
  Effect.all(identities.map(readArtifact), { concurrency: 2 }).pipe(
    Effect.timeout("45 seconds"),
  );

class ArtifactNotReady extends Data.TaggedError(
  "ArtifactNotReady",
)<NotificationIdentity> {}

class DeliveryNotReady extends Data.TaggedError("DeliveryNotReady")<{
  eventName: string;
}> {}

class EvidenceNotReady extends Data.TaggedError("EvidenceNotReady")<{
  key: string;
}> {}

class FixtureResourceStillExists extends Data.TaggedError(
  "FixtureResourceStillExists",
)<{
  resource: string;
}> {}

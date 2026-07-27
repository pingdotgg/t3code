import * as AWS from "@/AWS";
import { MetricStream } from "@/AWS/CloudWatch";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Alchemy";
import { AWSEnvironment } from "@/AWS/Environment";
import * as cloudwatch from "@distilled.cloud/aws/cloudwatch";
import * as firehose from "@distilled.cloud/aws/firehose";
import * as iam from "@distilled.cloud/aws/iam";
import * as s3 from "@distilled.cloud/aws/s3";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: AWS.providers() });

// Deterministic out-of-band names (no Date.now — stable across re-runs).
const suffix = "alchemy-test-metricstream-list";
const bucketName = `${suffix}-bucket`;
const firehoseRoleName = `${suffix}-fh-role`;
const firehoseName = `${suffix}-fh`;
const streamRoleName = `${suffix}-ms-role`;

const trustPolicy = (service: string) =>
  JSON.stringify({
    Version: "2012-10-17",
    Statement: [
      {
        Effect: "Allow",
        Principal: { Service: service },
        Action: "sts:AssumeRole",
      },
    ],
  });

// `list()` enumerates every CloudWatch metric stream in the account/region via
// the paginated `cloudwatch.listMetricStreams` op, re-reading each entry with
// `getMetricStream` to produce the full Attributes shape. A metric stream
// requires a live Firehose delivery stream + an assumable IAM role, so we stand
// up the Firehose (S3-backed) and both roles out-of-band via distilled, deploy a
// real MetricStream, resolve the provider via the typed `findProvider`, call
// `list()`, and assert the deployed stream appears in the exhaustively
// paginated result.
//
// Gated off by default (AWS_TEST_METRICSTREAM=1): the live setup provisions a
// Firehose delivery stream (CREATING -> ACTIVE can take a couple of minutes) and
// depends on fresh-IAM-role propagation, which is too slow/flaky for default CI.
test.provider.skipIf(!process.env.AWS_TEST_METRICSTREAM)(
  "list enumerates the deployed metric stream",
  (stack) =>
    Effect.gen(function* () {
      const { region } = yield* AWSEnvironment.current;

      // Idempotent cleanup: every delete tolerates ONLY its typed not-found
      // tag, so a real failure (e.g. a dependency violation) surfaces and
      // fails the test instead of silently orphaning the resource.
      const emptyBucket = Effect.gen(function* () {
        const listed = yield* s3.listObjectsV2({ Bucket: bucketName });
        const objects = (listed.Contents ?? []).flatMap((o) =>
          o.Key ? [{ Key: o.Key }] : [],
        );
        if (objects.length > 0) {
          yield* s3.deleteObjects({
            Bucket: bucketName,
            Delete: { Objects: objects },
          });
        }
        return listed.IsTruncated === true;
      }).pipe(Effect.repeat({ until: (truncated) => !truncated, times: 8 }));

      const cleanup = Effect.gen(function* () {
        yield* firehose
          .deleteDeliveryStream({
            DeliveryStreamName: firehoseName,
            AllowForceDelete: true,
          })
          .pipe(
            Effect.retry({
              while: (e) => e._tag === "ResourceInUseException",
              schedule: Schedule.spaced("5 seconds"),
              times: 8,
            }),
            Effect.catchTag("ResourceNotFoundException", () => Effect.void),
          );
        yield* iam
          .deleteRolePolicy({
            RoleName: firehoseRoleName,
            PolicyName: "s3",
          })
          .pipe(Effect.catchTag("NoSuchEntityException", () => Effect.void));
        yield* iam
          .deleteRole({ RoleName: firehoseRoleName })
          .pipe(Effect.catchTag("NoSuchEntityException", () => Effect.void));
        yield* iam
          .deleteRolePolicy({
            RoleName: streamRoleName,
            PolicyName: "firehose",
          })
          .pipe(Effect.catchTag("NoSuchEntityException", () => Effect.void));
        yield* iam
          .deleteRole({ RoleName: streamRoleName })
          .pipe(Effect.catchTag("NoSuchEntityException", () => Effect.void));
        // The Firehose may have delivered objects into the bucket — empty it
        // first, and retry once more if a late delivery races the delete.
        yield* emptyBucket.pipe(
          Effect.andThen(s3.deleteBucket({ Bucket: bucketName })),
          Effect.retry({
            while: (e) => e._tag === "BucketNotEmpty",
            schedule: Schedule.spaced("2 seconds"),
            times: 3,
          }),
          Effect.catchTag("NoSuchBucket", () => Effect.void),
        );
      });

      yield* stack.destroy();
      yield* cleanup;

      yield* Effect.gen(function* () {
        // S3 destination bucket for the Firehose.
        yield* s3
          .createBucket({
            Bucket: bucketName,
            ...(region === "us-east-1"
              ? {}
              : {
                  CreateBucketConfiguration: {
                    LocationConstraint: region,
                  },
                }),
          } as any)
          .pipe(
            Effect.catchTag("BucketAlreadyOwnedByYou", () => Effect.void),
            Effect.catchTag("BucketAlreadyExists", () => Effect.void),
          );

        const bucketArn = `arn:aws:s3:::${bucketName}`;

        // Role CloudWatch assumes to write metrics into the Firehose. Created
        // first so it has the longest time to propagate before use.
        const streamRole = yield* iam.createRole({
          RoleName: streamRoleName,
          AssumeRolePolicyDocument: trustPolicy(
            "streams.metrics.cloudwatch.amazonaws.com",
          ),
        });
        const streamRoleArn = streamRole.Role.Arn;

        // Role the Firehose assumes to write to S3.
        const firehoseRole = yield* iam.createRole({
          RoleName: firehoseRoleName,
          AssumeRolePolicyDocument: trustPolicy("firehose.amazonaws.com"),
        });
        const firehoseRoleArn = firehoseRole.Role.Arn;

        yield* iam.putRolePolicy({
          RoleName: firehoseRoleName,
          PolicyName: "s3",
          PolicyDocument: JSON.stringify({
            Version: "2012-10-17",
            Statement: [
              {
                Effect: "Allow",
                Action: [
                  "s3:AbortMultipartUpload",
                  "s3:GetBucketLocation",
                  "s3:GetObject",
                  "s3:ListBucket",
                  "s3:ListBucketMultipartUploads",
                  "s3:PutObject",
                ],
                Resource: [bucketArn, `${bucketArn}/*`],
              },
            ],
          }),
        });

        // Create the Firehose, retrying while IAM role propagation makes the
        // delivery role temporarily un-assumable.
        const created = yield* firehose
          .createDeliveryStream({
            DeliveryStreamName: firehoseName,
            DeliveryStreamType: "DirectPut",
            S3DestinationConfiguration: {
              RoleARN: firehoseRoleArn,
              BucketARN: bucketArn,
            },
          })
          .pipe(
            Effect.catchTag("ResourceInUseException", () =>
              firehose
                .describeDeliveryStream({ DeliveryStreamName: firehoseName })
                .pipe(
                  Effect.map((d) => ({
                    DeliveryStreamARN:
                      d.DeliveryStreamDescription.DeliveryStreamARN,
                  })),
                ),
            ),
            Effect.retry({
              while: (e) => e._tag === "InvalidArgumentException",
              schedule: Schedule.max([
                Schedule.spaced("5 seconds"),
                Schedule.recurs(8),
              ]),
            }),
          );

        const firehoseArn = created.DeliveryStreamARN!;

        // Wait for the Firehose to become ACTIVE before CloudWatch will accept it.
        yield* firehose
          .describeDeliveryStream({ DeliveryStreamName: firehoseName })
          .pipe(
            Effect.map((d) => d.DeliveryStreamDescription.DeliveryStreamStatus),
            Effect.tap((status) =>
              status === "ACTIVE"
                ? Effect.void
                : Effect.fail("not-active" as const),
            ),
            Effect.retry({
              while: (e) => e === "not-active",
              schedule: Schedule.max([
                Schedule.spaced("10 seconds"),
                Schedule.recurs(10),
              ]),
            }),
            Effect.catch(() => Effect.void),
          );

        yield* iam.putRolePolicy({
          RoleName: streamRoleName,
          PolicyName: "firehose",
          PolicyDocument: JSON.stringify({
            Version: "2012-10-17",
            Statement: [
              {
                Effect: "Allow",
                Action: ["firehose:PutRecord", "firehose:PutRecordBatch"],
                Resource: [firehoseArn],
              },
            ],
          }),
        });

        const deployed = yield* stack.deploy(
          Effect.gen(function* () {
            return yield* MetricStream("ListMetricStream", {
              name: "alchemy-test-metricstream-list",
              FirehoseArn: firehoseArn,
              RoleArn: streamRoleArn,
              OutputFormat: "json",
            });
          }),
        );

        const provider = yield* Provider.findProvider(MetricStream);
        const all = yield* provider.list();

        expect(
          all.some((ms) => ms.metricStreamName === deployed.metricStreamName),
        ).toBe(true);

        yield* stack.destroy();

        // Out-of-band assert-gone: getMetricStream returns the typed
        // ResourceNotFoundException once the stream is deleted.
        const gone = yield* cloudwatch
          .getMetricStream({ Name: deployed.metricStreamName })
          .pipe(
            Effect.map(() => false),
            Effect.catchTag("ResourceNotFoundException", () =>
              Effect.succeed(true),
            ),
          );
        expect(gone).toBe(true);
      }).pipe(Effect.ensuring(cleanup.pipe(Effect.orDie)));
    }),
  { timeout: 240_000 },
);

/**
 * Event-source-mapping conformance against the floci emulator, driven
 * entirely through OUR client stack (distilled SDK + alchemy providers).
 *
 * Topology (all local, dev mode, no profile stub):
 *   - `AWS.SQS.Queue` + `AWS.S3.Bucket` + `AWS.IAM.Role` deploy through the
 *     dualized providers into floci;
 *   - a RAW floci Lambda is created via distilled `lambda.createFunction`
 *     against the emulator endpoint (the Lambda.Function RESOURCE is out of
 *     scope for F1) — its handler writes each consumed SQS message into the
 *     bucket;
 *   - the event source mapping is created via distilled
 *     `lambda.createEventSourceMapping` (the alchemy EventSourceMapping
 *     resource is NOT dualized: its ownership scan needs lambda ListTags on
 *     `event-source-mapping:` ARNs, which floci rejects — see the F1
 *     fork-patch candidates);
 *   - `sqs.sendMessage` through distilled, then a bounded poll for the
 *     object the function writes — pinning floci's local event pumping
 *     (ESM poller -> containerized Lambda -> S3 write-back) end to end.
 *
 * Requires Docker (floci + the Lambda runtime container); skipped when the
 * daemon is unavailable.
 */
import * as AWS from "@/AWS";
import * as Endpoint from "@/AWS/Endpoint.ts";
import * as Region from "@/AWS/Region.ts";
import * as Test from "@/Test/Alchemy";
import { zipCode } from "@/Util/zip.ts";
import { Credentials } from "@distilled.cloud/aws/Credentials";
import type { RegionName } from "@distilled.cloud/aws/Region";
import * as Lambda from "@distilled.cloud/aws/lambda";
import * as SQS from "@distilled.cloud/aws/sqs";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import {
  dockerAvailable,
  FLOCI_ENDPOINT,
  rawS3GetObject,
} from "./fixtures/raw.ts";

const { test } = Test.make({ providers: AWS.providers(), dev: true });

/**
 * Floci-scoped context for the raw distilled calls this test makes itself
 * (create/delete the Lambda function, send the SQS message) — the same
 * client stack the wrapped local providers use.
 */
const flociContext = Layer.mergeAll(
  Endpoint.of(FLOCI_ENDPOINT),
  Region.of("us-east-1"),
  Layer.succeed(
    Credentials,
    Effect.succeed({
      accessKeyId: Redacted.make("test"),
      secretAccessKey: Redacted.make("test"),
      sessionToken: undefined,
      region: "us-east-1" as RegionName,
    }),
  ),
);

const FUNCTION_NAME = "alchemy-local-esm-consumer";
const MARKER_KEY = "consumed-marker.txt";

/**
 * nodejs20.x handler: writes each consumed SQS record into the target
 * bucket under the key carried in the message body. The Lambda runtime
 * container gets `AWS_ENDPOINT_URL` + placeholder credentials from floci,
 * so the bundled AWS SDK v3 targets the emulator; path-style is forced
 * because virtual-host bucket DNS does not resolve locally.
 */
const handlerSource = /* js */ `
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
const s3 = new S3Client({
  endpoint: process.env.AWS_ENDPOINT_URL,
  forcePathStyle: true,
});
export const handler = async (event) => {
  for (const record of event.Records ?? []) {
    await s3.send(
      new PutObjectCommand({
        Bucket: process.env.TARGET_BUCKET,
        Key: record.body,
        Body: record.messageId,
      }),
    );
  }
  return { batchItemFailures: [] };
};
`;

const assumeRolePolicy = {
  Version: "2012-10-17" as const,
  Statement: [
    {
      Effect: "Allow" as const,
      Principal: { Service: "lambda.amazonaws.com" },
      Action: ["sts:AssumeRole"],
    },
  ],
};

test.provider.skipIf(!dockerAvailable)(
  "SQS -> raw floci Lambda -> S3 event pumping through our client stack",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      // Phase 1: the data plane the function needs (all floci-local).
      const base = yield* stack.deploy(
        Effect.gen(function* () {
          const queue = yield* AWS.SQS.Queue("EsmQueue");
          const bucket = yield* AWS.S3.Bucket("EsmTarget", {
            forceDestroy: true,
          });
          const role = yield* AWS.IAM.Role("EsmRole", {
            assumeRolePolicyDocument: assumeRolePolicy,
          });
          return { queue, bucket, role };
        }),
      );
      expect(base.queue.queueArn).toContain(":000000000000:");
      expect(base.bucket.bucketName).toBeDefined();

      // Pre-clean: the emulator container is long-lived, so a previous
      // interrupted run may have left the function (with a stale
      // TARGET_BUCKET env) and event source mappings whose pollers spin on
      // deleted queues. Delete mappings first, then the function.
      const leftover = yield* Lambda.listEventSourceMappings({
        FunctionName: FUNCTION_NAME,
      }).pipe(
        Effect.catchTag("ResourceNotFoundException", () =>
          Effect.succeed({ EventSourceMappings: [] }),
        ),
        Effect.provide(flociContext),
      );
      yield* Effect.forEach(leftover.EventSourceMappings ?? [], (mapping) =>
        mapping.UUID
          ? Lambda.deleteEventSourceMapping({ UUID: mapping.UUID }).pipe(
              Effect.catchTag("ResourceNotFoundException", () => Effect.void),
              Effect.provide(flociContext),
            )
          : Effect.void,
      );
      yield* Lambda.deleteFunction({ FunctionName: FUNCTION_NAME }).pipe(
        Effect.catchTag("ResourceNotFoundException", () => Effect.void),
        Effect.provide(flociContext),
      );

      // Raw floci Lambda via distilled against the emulator endpoint.
      const archive = yield* zipCode(handlerSource);
      yield* Lambda.createFunction({
        FunctionName: FUNCTION_NAME,
        Runtime: "nodejs20.x",
        Handler: "index.handler",
        Role: base.role.roleArn,
        Code: { ZipFile: archive },
        Timeout: 30,
        Environment: {
          Variables: { TARGET_BUCKET: base.bucket.bucketName },
        },
      }).pipe(Effect.provide(flociContext));

      // Wait (bounded) for the function to be Active before wiring the ESM.
      const fn = yield* Lambda.getFunction({
        FunctionName: FUNCTION_NAME,
      }).pipe(
        Effect.provide(flociContext),
        Effect.repeat({
          schedule: Schedule.spaced("2 seconds"),
          until: (res): boolean => res.Configuration?.State === "Active",
          times: 30,
        }),
      );
      expect(fn.Configuration?.State).toBe("Active");

      // Wire queue -> fn via distilled against the emulator (our client
      // stack end to end).
      const esm = yield* Lambda.createEventSourceMapping({
        FunctionName: FUNCTION_NAME,
        EventSourceArn: base.queue.queueArn,
        BatchSize: 1,
        Enabled: true,
      }).pipe(Effect.provide(flociContext));
      expect(esm.UUID).toBeDefined();

      // Send through OUR client stack (distilled sqs against the emulator).
      yield* SQS.sendMessage({
        QueueUrl: base.queue.queueUrl,
        MessageBody: MARKER_KEY,
      }).pipe(Effect.provide(flociContext));

      // Bounded poll: floci's ESM poller must deliver the message to the
      // containerized function, whose S3 write-back proves consumption.
      const consumed = yield* rawS3GetObject(
        base.bucket.bucketName,
        MARKER_KEY,
      ).pipe(
        Effect.repeat({
          schedule: Schedule.spaced("3 seconds"),
          until: (res): boolean => res.status === 200,
          times: 40,
        }),
      );
      expect(consumed.status).toBe(200);

      // Cleanup: remove the raw mapping + function from the emulator, then
      // destroy the stack (queue, bucket incl. the object, role).
      if (esm.UUID) {
        yield* Lambda.deleteEventSourceMapping({ UUID: esm.UUID }).pipe(
          Effect.catchTag("ResourceNotFoundException", () => Effect.void),
          Effect.provide(flociContext),
        );
      }
      yield* Lambda.deleteFunction({ FunctionName: FUNCTION_NAME }).pipe(
        Effect.catchTag("ResourceNotFoundException", () => Effect.void),
        Effect.provide(flociContext),
      );
      yield* stack.destroy();
    }),
  { timeout: 540_000 },
);

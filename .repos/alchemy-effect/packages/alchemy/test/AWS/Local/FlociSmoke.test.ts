/**
 * Floci local-emulator smoke test.
 *
 * Deploys real AWS resources (S3 Bucket, SQS Queue, DynamoDB Table) through
 * the regular live providers, but pointed at a locally-running floci emulator
 * via the `{ method: "local" }` AWS auth method.
 *
 * ## How local mode is activated
 *
 * The AWS auth method is normally chosen by the profile entry in
 * `~/.alchemy/profiles.json` (written by `alchemy login --configure`). Tests
 * must not depend on the developer's on-disk profiles, so this file overrides
 * the `AlchemyProfile` service with a stub whose `loadOrConfigure` always
 * returns `{ method: "local" }` for the AWS auth provider. The stub is
 * `Layer.provide`d directly onto `AWS.providers()`, so it only affects this
 * file — `AWSEnvironment.Default` then resolves dummy credentials
 * (`test`/`test`), accountId `000000000000`, and endpoint
 * `http://localhost:4566`, and `ensureFloci()` guarantees the emulator is
 * serving (starting the `alchemy-floci` container if needed).
 *
 * ## Why no real-AWS calls can happen
 *
 * The `local` method's credentials are hardcoded dummies and its accountId is
 * fixed — it never calls STS. Every SDK call carries the emulator endpoint
 * (via `Endpoint.fromEnvironment`); if any call ever escaped to real AWS it
 * would fail auth immediately (the dummy keys exist in no real account).
 *
 * Requires Docker (floci runs as a container); skipped when the Docker
 * daemon is unavailable.
 */
import * as AWS from "@/AWS";
import { AlchemyProfile, type ProfileService } from "@/Auth/Profile.ts";
import { Table } from "@/AWS/DynamoDB";
import { Bucket } from "@/AWS/S3";
import { Queue } from "@/AWS/SQS";
import * as Test from "@/Test/Alchemy";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpBody from "effect/unstable/http/HttpBody";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import { spawnSync } from "node:child_process";

const FLOCI_ENDPOINT = "http://localhost:4566";

// skipIf gate: floci runs as a Docker container. `docker info` proves the
// daemon is reachable (a mere `docker --version` would pass with the daemon
// down). Sync probe at collection time — skipIf needs a plain boolean.
const dockerAvailable = (() => {
  try {
    return (
      spawnSync("docker", ["info"], { stdio: "ignore", timeout: 15_000 })
        .status === 0
    );
  } catch {
    return false;
  }
})();

/**
 * Stub profile service forcing the AWS auth provider into
 * `{ method: "local" }` regardless of what is configured on disk.
 * `loadOrConfigure` mirrors the real implementation's `stored as Config`
 * narrowing (the generic `Config` is the auth provider's own config type).
 */
const localProfileStub: ProfileService = {
  readConfig: Effect.succeed({ version: 0, profiles: {} }),
  writeConfig: () => Effect.void,
  getProfile: () => Effect.succeed({ AWS: { method: "local" } }),
  setProfile: () => Effect.void,
  deleteProfile: () => Effect.succeed(false),
  loadOrConfigure: <Config extends { method: string }>() =>
    Effect.succeed({ method: "local" } as Config),
};

const providers = AWS.providers().pipe(
  Layer.provide(Layer.succeed(AlchemyProfile, localProfileStub)),
);

const { test } = Test.make({ providers });

/**
 * Raw (non-distilled) call against the emulator gateway — out-of-band proof
 * that a resource exists IN THE EMULATOR, not the real cloud. The dummy
 * SigV4 Authorization header is never verified by the emulator; it only
 * carries the service/region/account scoping the gateway routes by.
 */
const rawAwsJson = Effect.fn(function* (options: {
  service: string;
  region: string;
  target: string;
  contentType: string;
  body: Record<string, unknown>;
}) {
  const client = yield* HttpClient.HttpClient;
  return yield* client.execute(
    HttpClientRequest.post(`${FLOCI_ENDPOINT}/`).pipe(
      HttpClientRequest.setHeaders({
        "content-type": options.contentType,
        "x-amz-target": options.target,
        "x-amz-date": "20260101T000000Z",
        authorization: `AWS4-HMAC-SHA256 Credential=test/20260101/${options.region}/${options.service}/aws4_request, SignedHeaders=host;x-amz-date, Signature=dummy`,
      }),
      HttpClientRequest.setBody(
        HttpBody.text(JSON.stringify(options.body), options.contentType),
      ),
    ),
  );
});

/** Path-style S3 GET against the gateway (list the bucket's objects). */
const rawS3GetBucket = Effect.fn(function* (bucketName: string) {
  const client = yield* HttpClient.HttpClient;
  return yield* client.execute(
    HttpClientRequest.get(`${FLOCI_ENDPOINT}/${bucketName}`).pipe(
      HttpClientRequest.setHeaders({
        "x-amz-date": "20260101T000000Z",
        authorization:
          "AWS4-HMAC-SHA256 Credential=test/20260101/us-east-1/s3/aws4_request, SignedHeaders=host;x-amz-date, Signature=dummy",
      }),
    ),
  );
});

/** Region segment of an ARN (`arn:aws:sqs:REGION:ACCOUNT:name`). */
const regionOfArn = (arn: string) => arn.split(":")[3]!;

test.provider.skipIf(!dockerAvailable)(
  "deploys S3 + SQS + DynamoDB into floci and destroys them",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const outputs = yield* stack.deploy(
        Effect.gen(function* () {
          const bucket = yield* Bucket("FlociBucket");
          const queue = yield* Queue("FlociQueue");
          const table = yield* Table("FlociTable", {
            partitionKey: "id",
            attributes: { id: "S" },
          });
          return { bucket, queue, table };
        }),
      );

      // Attributes prove the providers ran their full reconcile loops. The
      // dummy-account ARNs double as proof no real AWS account was involved.
      expect(outputs.bucket.bucketName).toBeDefined();
      expect(outputs.bucket.bucketArn).toContain(outputs.bucket.bucketName);
      expect(outputs.queue.queueUrl).toContain(outputs.queue.queueName);
      expect(outputs.queue.queueArn).toContain(":000000000000:");
      expect(outputs.table.tableArn).toContain(":000000000000:");

      const region = regionOfArn(outputs.queue.queueArn);

      // --- Out-of-band verification: raw HTTP against the emulator gateway,
      // no distilled SDK, no alchemy layers. If the resources had gone to
      // real AWS these calls would not find them here.
      const listQueues = yield* rawAwsJson({
        service: "sqs",
        region,
        target: "AmazonSQS.ListQueues",
        contentType: "application/x-amz-json-1.0",
        body: {},
      });
      expect(listQueues.status).toBe(200);
      const queues = (yield* listQueues.json) as { QueueUrls?: string[] };
      expect(
        queues.QueueUrls?.some((url) =>
          url.endsWith(`/${outputs.queue.queueName}`),
        ),
      ).toBe(true);

      const describeTable = yield* rawAwsJson({
        service: "dynamodb",
        region: regionOfArn(outputs.table.tableArn),
        target: "DynamoDB_20120810.DescribeTable",
        contentType: "application/x-amz-json-1.0",
        body: { TableName: outputs.table.tableName },
      });
      expect(describeTable.status).toBe(200);
      const described = (yield* describeTable.json) as {
        Table?: { TableArn?: string };
      };
      expect(described.Table?.TableArn).toBe(outputs.table.tableArn);

      const getBucket = yield* rawS3GetBucket(outputs.bucket.bucketName);
      expect(getBucket.status).toBe(200);

      // --- Destroy and verify gone from the emulator.
      yield* stack.destroy();

      const listQueuesAfter = yield* rawAwsJson({
        service: "sqs",
        region,
        target: "AmazonSQS.ListQueues",
        contentType: "application/x-amz-json-1.0",
        body: {},
      });
      const queuesAfter = (yield* listQueuesAfter.json) as {
        QueueUrls?: string[];
      };
      expect(
        queuesAfter.QueueUrls?.some((url) =>
          url.endsWith(`/${outputs.queue.queueName}`),
        ) ?? false,
      ).toBe(false);

      const describeTableAfter = yield* rawAwsJson({
        service: "dynamodb",
        region: regionOfArn(outputs.table.tableArn),
        target: "DynamoDB_20120810.DescribeTable",
        contentType: "application/x-amz-json-1.0",
        body: { TableName: outputs.table.tableName },
      });
      expect(describeTableAfter.status).toBe(400); // ResourceNotFoundException

      const getBucketAfter = yield* rawS3GetBucket(outputs.bucket.bucketName);
      expect(getBucketAfter.status).toBe(404); // NoSuchBucket
    }),
  { timeout: 240_000 },
);

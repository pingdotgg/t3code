/**
 * Mode-scoped local dev for the AWS serverless data plane.
 *
 * `Test.make({ dev: true })` alone (no profile stub, no endpoint config)
 * must route the dualized data-plane resources to the floci emulator: each
 * `flociDual` registration in `AWS/Providers.ts` builds the SAME live
 * provider code with every lifecycle method wrapped in the floci override
 * context (endpoint `http://localhost:4566`, dummy credentials, account
 * `000000000000`, region `us-east-1`).
 *
 * Proof structure:
 *   - attrs carry the dummy account (`:000000000000:` ARNs) and localhost
 *     queue URL — the live cloud can never produce these;
 *   - persisted state rows are stamped `providerMode: "local"` (the
 *     stamping/replacement law of ProviderLayer.dual then guarantees a live
 *     deploy plans replacements — pinned by test/provider-mode.test.ts);
 *   - out-of-band raw HTTP against the emulator gateway finds the
 *     resources (and finds them gone after destroy);
 *   - `Alchemy.remote()` opts a resource back to the live provider even in
 *     dev: real-account identity, out-of-band verification through the real
 *     cloud API, and a live delete on destroy.
 *
 * Requires Docker (floci runs as a container); skipped when unavailable.
 */
import * as AWS from "@/AWS";
import * as Alchemy from "@/index.ts";
import { State, type ResourceState } from "@/State";
import { Stack } from "@/Stack";
import * as Test from "@/Test/Alchemy";
import * as SSM from "@distilled.cloud/aws/ssm";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import {
  dockerAvailable,
  rawAwsJson,
  rawAwsQuery,
  rawS3GetBucket,
  regionOfArn,
} from "./fixtures/raw.ts";
import { liveContext } from "./fixtures/live.ts";

const { test } = Test.make({ providers: AWS.providers(), dev: true });

const getState = Effect.fn(function* (fqn: string) {
  const state = yield* yield* State;
  const stk = yield* Stack;
  return (yield* state.get({
    stack: stk.name,
    stage: stk.stage,
    fqn,
  })) as ResourceState | undefined;
});

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
  "dev mode routes the serverless data plane to floci and stamps local mode",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const outputs = yield* stack.deploy(
        Effect.gen(function* () {
          const bucket = yield* AWS.S3.Bucket("DataBucket");
          const queue = yield* AWS.SQS.Queue("DataQueue");
          const table = yield* AWS.DynamoDB.Table("DataTable", {
            partitionKey: "id",
            attributes: { id: "S" },
          });
          // Requires the alchemy floci fork ≥ 1.6.0-alchemy.2: the Topic
          // reconciler observes SNS GetDataProtectionPolicy unconditionally
          // on standard topics, which stock floci 1.6.0 rejects.
          const topic = yield* AWS.SNS.Topic("DataTopic");
          const secret = yield* AWS.SecretsManager.Secret("DataSecret", {
            secretString: Redacted.make("local-secret-value"),
          });
          const parameter = yield* AWS.SSM.Parameter("DataParameter", {
            value: "local-parameter-value",
          });
          const role = yield* AWS.IAM.Role("DataRole", {
            assumeRolePolicyDocument: assumeRolePolicy,
          });
          const bus = yield* AWS.EventBridge.EventBus("DataBus");
          const rule = yield* AWS.EventBridge.Rule("DataRule", {
            eventBusName: bus.eventBusName,
            eventPattern: { source: ["alchemy.local-test"] },
          });
          return {
            bucket,
            queue,
            table,
            topic,
            secret,
            parameter,
            role,
            bus,
            rule,
          };
        }),
      );

      // --- Dummy-account identities: the live cloud can never mint these.
      expect(outputs.queue.queueArn).toContain(":000000000000:");
      expect(outputs.queue.queueUrl).toContain("localhost");
      expect(outputs.table.tableArn).toContain(":000000000000:");
      expect(outputs.topic.topicArn).toContain(":000000000000:");
      expect(outputs.secret.secretArn).toContain(":000000000000:");
      expect(outputs.parameter.parameterArn).toContain(":000000000000:");
      expect(outputs.role.roleArn).toContain("::000000000000:");
      expect(outputs.bus.eventBusArn).toContain(":000000000000:");
      expect(outputs.rule.ruleArn).toContain(":000000000000:");
      expect(outputs.bucket.bucketArn).toContain(outputs.bucket.bucketName);

      // --- Stamped-mode proof: every dualized row commits providerMode
      // "local" (the replacement-on-mode-switch law is pinned by
      // provider-mode.test.ts on exactly this stamp).
      for (const fqn of [
        "DataBucket",
        "DataQueue",
        "DataTable",
        "DataTopic",
        "DataSecret",
        "DataParameter",
        "DataRole",
        "DataBus",
        "DataRule",
      ]) {
        const row = yield* getState(fqn);
        expect(`${fqn}:${row?.status}`).toBe(`${fqn}:created`);
        expect(`${fqn}:${row?.providerMode}`).toBe(`${fqn}:local`);
      }

      const region = regionOfArn(outputs.queue.queueArn);

      // --- Out-of-band: raw HTTP against the emulator gateway (no distilled
      // SDK, no alchemy layers). Real-cloud resources would not be here.
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
        region,
        target: "DynamoDB_20120810.DescribeTable",
        contentType: "application/x-amz-json-1.0",
        body: { TableName: outputs.table.tableName },
      });
      expect(describeTable.status).toBe(200);

      const getBucket = yield* rawS3GetBucket(outputs.bucket.bucketName);
      expect(getBucket.status).toBe(200);

      const getTopicAttrs = yield* rawAwsQuery({
        service: "sns",
        region,
        params: {
          Action: "GetTopicAttributes",
          Version: "2010-03-31",
          TopicArn: outputs.topic.topicArn,
        },
      });
      expect(getTopicAttrs.status).toBe(200);

      const getParameter = yield* rawAwsJson({
        service: "ssm",
        region,
        target: "AmazonSSM.GetParameter",
        contentType: "application/x-amz-json-1.1",
        body: { Name: outputs.parameter.parameterName },
      });
      expect(getParameter.status).toBe(200);
      const param = (yield* getParameter.json) as {
        Parameter?: { Value?: string };
      };
      expect(param.Parameter?.Value).toBe("local-parameter-value");

      const describeSecret = yield* rawAwsJson({
        service: "secretsmanager",
        region,
        target: "secretsmanager.DescribeSecret",
        contentType: "application/x-amz-json-1.1",
        body: { SecretId: outputs.secret.secretArn },
      });
      expect(describeSecret.status).toBe(200);

      // --- Destroy and verify gone from the emulator.
      yield* stack.destroy();

      const queuesAfter = (yield* (yield* rawAwsJson({
        service: "sqs",
        region,
        target: "AmazonSQS.ListQueues",
        contentType: "application/x-amz-json-1.0",
        body: {},
      })).json) as { QueueUrls?: string[] };
      expect(
        queuesAfter.QueueUrls?.some((url) =>
          url.endsWith(`/${outputs.queue.queueName}`),
        ) ?? false,
      ).toBe(false);

      const tableAfter = yield* rawAwsJson({
        service: "dynamodb",
        region,
        target: "DynamoDB_20120810.DescribeTable",
        contentType: "application/x-amz-json-1.0",
        body: { TableName: outputs.table.tableName },
      });
      expect(tableAfter.status).toBe(400); // ResourceNotFoundException

      const bucketAfter = yield* rawS3GetBucket(outputs.bucket.bucketName);
      expect(bucketAfter.status).toBe(404); // NoSuchBucket

      const topicAfter = yield* rawAwsQuery({
        service: "sns",
        region,
        params: {
          Action: "GetTopicAttributes",
          Version: "2010-03-31",
          TopicArn: outputs.topic.topicArn,
        },
      });
      expect(topicAfter.status).toBe(404); // NotFoundException
    }),
  { timeout: 300_000 },
);

/**
 * `Alchemy.remote()` opts a resource OUT of local emulation: even in a dev
 * run the parameter is created on real AWS by the live provider variant
 * (testing-profile credentials), its state row is stamped `live`, and the
 * destroy deletes it from the real cloud.
 */
test.provider.skipIf(!dockerAvailable)(
  "Alchemy.remote() parameter runs live in dev alongside a local one",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const outputs = yield* stack.deploy(
        Effect.gen(function* () {
          const localParam = yield* AWS.SSM.Parameter("MixedLocalParam", {
            value: "local-value",
          });
          const liveParam = yield* AWS.SSM.Parameter("MixedLiveParam", {
            value: "live-value",
          }).pipe(Alchemy.remote());
          return { localParam, liveParam };
        }),
      );

      // The default parameter is emulated; the remote() one is real.
      expect(outputs.localParam.parameterArn).toContain(":000000000000:");
      expect(outputs.liveParam.parameterArn).not.toContain(":000000000000:");
      expect((yield* getState("MixedLocalParam"))?.providerMode).toBe("local");
      expect((yield* getState("MixedLiveParam"))?.providerMode).toBe("live");

      // Out-of-band: read the REAL cloud explicitly (the ambient
      // environment in a dev run is the emulator) — the remote() parameter
      // must be there with its value.
      const live = yield* SSM.getParameter({
        Name: outputs.liveParam.parameterName,
      }).pipe(Effect.provide(liveContext));
      const liveValue = live.Parameter?.Value;
      expect(
        typeof liveValue === "string" ? liveValue : Redacted.value(liveValue!),
      ).toBe("live-value");

      yield* stack.destroy();

      // The live parameter was deleted from the real cloud on destroy (its
      // state row is stamped live, so the live provider handles the delete
      // even in a dev run).
      const gone = yield* SSM.getParameter({
        Name: outputs.liveParam.parameterName,
      }).pipe(
        Effect.as(false),
        Effect.catchTag("ParameterNotFound", () => Effect.succeed(true)),
        Effect.provide(liveContext),
      );
      expect(gone).toBe(true);
    }),
  { timeout: 300_000 },
);

import * as AWS from "@/AWS";
import { Flow } from "@/AWS/AppFlow";
import type { PolicyStatement } from "@/AWS/IAM";
import { Bucket } from "@/AWS/S3";
import * as Test from "@/Test/Alchemy";
import * as appflow from "@distilled.cloud/aws/appflow";
import * as s3 from "@distilled.cloud/aws/s3";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: AWS.providers() });

// Deterministic bucket used as both flow source and destination (distinct
// prefixes). AppFlow requires the bucket policy to authorize the service
// principal for reads (source) and writes (destination).
const BUCKET = "alchemy-test-appflow-flow";
const BUCKET_ARN = `arn:aws:s3:::${BUCKET}`;

const appflowBucketPolicy: PolicyStatement[] = [
  {
    Effect: "Allow",
    Principal: { Service: "appflow.amazonaws.com" },
    Action: ["s3:GetObject", "s3:ListBucket"],
    Resource: [BUCKET_ARN, `${BUCKET_ARN}/*`],
  },
  {
    Effect: "Allow",
    Principal: { Service: "appflow.amazonaws.com" },
    Action: [
      "s3:PutObject",
      "s3:AbortMultipartUpload",
      "s3:ListMultipartUploadParts",
      "s3:ListBucketMultipartUploads",
      "s3:GetBucketAcl",
      "s3:PutObjectAcl",
    ],
    Resource: [BUCKET_ARN, `${BUCKET_ARN}/*`],
  },
];

const bucketProgram = Effect.gen(function* () {
  return yield* Bucket("FlowBucket", {
    bucketName: BUCKET,
    forceDestroy: true,
    policy: appflowBucketPolicy,
  });
});

const flowProgram = (description: string) =>
  Effect.gen(function* () {
    const bucket = yield* bucketProgram;
    return yield* Flow("CopyFlow", {
      description,
      triggerConfig: { triggerType: "OnDemand" },
      sourceFlowConfig: {
        connectorType: "S3",
        sourceConnectorProperties: {
          S3: { bucketName: bucket.bucketName, bucketPrefix: "input" },
        },
      },
      destinationFlowConfigList: [
        {
          connectorType: "S3",
          destinationConnectorProperties: {
            S3: { bucketName: bucket.bucketName, bucketPrefix: "output" },
          },
        },
      ],
      tasks: [
        {
          taskType: "Map_all",
          sourceFields: [],
          connectorOperator: { S3: "NO_OP" },
          taskProperties: {},
        },
      ],
    });
  });

const assertFlowGone = (flowName: string) =>
  Effect.gen(function* () {
    const result = yield* appflow.describeFlow({ flowName }).pipe(
      Effect.map(() => "present" as const),
      Effect.catchTag("ResourceNotFoundException", () =>
        Effect.succeed("gone" as const),
      ),
    );
    if (result === "present") {
      return yield* Effect.fail(new Error(`Flow '${flowName}' still exists`));
    }
  }).pipe(
    Effect.retry({
      schedule: Schedule.max([Schedule.fixed("2 seconds"), Schedule.recurs(8)]),
    }),
  );

// The S3-to-S3 path is credential-free, so the full lifecycle runs ungated.
test.provider(
  "create, update, and destroy an S3-to-S3 flow",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      // Phase 1: the bucket alone. AppFlow's S3 connector validates the flow
      // by listing the source prefix at createFlow time — the prefix must
      // contain at least one object or createFlow fails with
      // ConnectorServerException.
      yield* stack.deploy(bucketProgram);
      yield* s3.putObject({
        Bucket: BUCKET,
        Key: "input/data.csv",
        Body: new TextEncoder().encode("id,name\n1,alpha\n2,beta\n"),
        ContentType: "text/csv",
      });

      // Phase 2: create the flow.
      const created = yield* stack.deploy(flowProgram("initial description"));
      expect(created.flowName).toBeDefined();
      expect(created.flowArn).toContain(":appflow:");

      // Out-of-band verification.
      const described = yield* appflow.describeFlow({
        flowName: created.flowName,
      });
      expect(described.description).toBe("initial description");
      expect(described.sourceFlowConfig?.connectorType).toBe("S3");
      expect(described.tags?.["alchemy::id"]).toBe("CopyFlow");

      // No-op redeploy keeps the same ARN.
      const noop = yield* stack.deploy(flowProgram("initial description"));
      expect(noop.flowArn).toBe(created.flowArn);

      // Update the description in place.
      const updated = yield* stack.deploy(flowProgram("updated description"));
      expect(updated.flowArn).toBe(created.flowArn);
      const reDescribed = yield* appflow.describeFlow({
        flowName: created.flowName,
      });
      expect(reDescribed.description).toBe("updated description");

      // Destroy and verify.
      yield* stack.destroy();
      yield* assertFlowGone(created.flowName);
    }),
  { timeout: 150_000 },
);

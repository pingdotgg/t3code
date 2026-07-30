import * as AWS from "@/AWS";
import { Capability, Transformer } from "@/AWS/B2BI";
import type { PolicyStatement } from "@/AWS/IAM";
import { Bucket } from "@/AWS/S3";
import * as Test from "@/Test/Alchemy";
import * as b2bi from "@distilled.cloud/aws/b2bi";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: AWS.providers() });

// Deterministic bucket for the capability's EDI input/output locations.
// B2BI accesses the bucket as the service principal, authorized by policy.
const BUCKET = "alchemy-test-b2bi-capability";
const BUCKET_ARN = `arn:aws:s3:::${BUCKET}`;

const b2biBucketPolicy: PolicyStatement[] = [
  {
    Effect: "Allow",
    Principal: { Service: "b2bi.amazonaws.com" },
    Action: [
      "s3:GetObject",
      "s3:PutObject",
      "s3:DeleteObject",
      "s3:ListBucket",
      "s3:GetBucketLocation",
      "s3:AbortMultipartUpload",
    ],
    Resource: [BUCKET_ARN, `${BUCKET_ARN}/*`],
  },
];

const capabilityProgram = (direction: "INBOUND" | "OUTBOUND") =>
  Effect.gen(function* () {
    const bucket = yield* Bucket("CapabilityBucket", {
      bucketName: BUCKET,
      forceDestroy: true,
      policy: b2biBucketPolicy,
    });
    const transformer = yield* Transformer("OrdersTransformer", {
      name: "alchemy-b2bi-cap-transformer",
      status: "active",
      inputConversion: {
        fromFormat: "X12",
        formatOptions: {
          x12: { transactionSet: "X12_850", version: "VERSION_4010" },
        },
      },
      mapping: {
        templateLanguage: "JSONATA",
        template: '{ "orderId": "test" }',
      },
    });
    return yield* Capability("Orders", {
      name: "alchemy-b2bi-capability",
      configuration: {
        edi: {
          capabilityDirection: direction,
          type: {
            x12Details: {
              transactionSet: "X12_850",
              version: "VERSION_4010",
            },
          },
          inputLocation: { bucketName: bucket.bucketName, key: "inbound/" },
          outputLocation: {
            bucketName: bucket.bucketName,
            key: "processed/",
          },
          transformerId: transformer.transformerId,
        },
      },
    });
  });

const assertCapabilityGone = (capabilityId: string) =>
  Effect.gen(function* () {
    const result = yield* b2bi.getCapability({ capabilityId }).pipe(
      Effect.map(() => "present" as const),
      Effect.catchTag("ResourceNotFoundException", () =>
        Effect.succeed("gone" as const),
      ),
    );
    if (result === "present") {
      return yield* Effect.fail(
        new Error(`Capability '${capabilityId}' still exists`),
      );
    }
  }).pipe(
    Effect.retry({
      schedule: Schedule.max([Schedule.fixed("2 seconds"), Schedule.recurs(8)]),
    }),
  );

// Capabilities are credential-free (bucket + transformer are self-service),
// so the full lifecycle runs ungated.
test.provider(
  "create, update, and destroy a B2BI capability",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      // Create an inbound EDI capability.
      const created = yield* stack.deploy(capabilityProgram("INBOUND"));
      expect(created.capabilityId).toMatch(/^ca-/);
      expect(created.name).toBe("alchemy-b2bi-capability");
      expect(created.type).toBe("edi");

      // Out-of-band verification.
      const described = yield* b2bi.getCapability({
        capabilityId: created.capabilityId,
      });
      expect(described.configuration.edi?.capabilityDirection).toBe("INBOUND");
      expect(described.configuration.edi?.inputLocation.key).toBe("inbound/");

      // No-op redeploy keeps the same id.
      const noop = yield* stack.deploy(capabilityProgram("INBOUND"));
      expect(noop.capabilityId).toBe(created.capabilityId);

      // Destroy and verify (capability, transformer, bucket all removed).
      yield* stack.destroy();
      yield* assertCapabilityGone(created.capabilityId);
    }),
  { timeout: 150_000 },
);

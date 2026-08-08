import * as AWS from "@/AWS";
import { Capability, Partnership, Profile, Transformer } from "@/AWS/B2BI";
import type { PolicyStatement } from "@/AWS/IAM";
import { Bucket } from "@/AWS/S3";
import * as Test from "@/Test/Alchemy";
import * as b2bi from "@distilled.cloud/aws/b2bi";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: AWS.providers() });

const BUCKET = "alchemy-test-b2bi-partnership";
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

const partnershipProgram = (partnershipName: string) =>
  Effect.gen(function* () {
    const bucket = yield* Bucket("PartnershipBucket", {
      bucketName: BUCKET,
      forceDestroy: true,
      policy: b2biBucketPolicy,
    });
    const profile = yield* Profile("TradingProfile", {
      name: "alchemy-b2bi-pt-profile",
      businessName: "Alchemy Trading Corp",
      phone: "+15555550100",
      email: "edi@alchemy.example",
    });
    const transformer = yield* Transformer("PtTransformer", {
      name: "alchemy-b2bi-pt-transformer",
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
    const capability = yield* Capability("PtCapability", {
      name: "alchemy-b2bi-pt-capability",
      configuration: {
        edi: {
          capabilityDirection: "INBOUND",
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
    return yield* Partnership("TradingPartner", {
      profileId: profile.profileId,
      name: partnershipName,
      email: "partner@alchemy.example",
      phone: "+15555550101",
      capabilities: [capability.capabilityId],
    });
  });

const assertPartnershipGone = (partnershipId: string) =>
  Effect.gen(function* () {
    const result = yield* b2bi.getPartnership({ partnershipId }).pipe(
      Effect.map(() => "present" as const),
      Effect.catchTag("ResourceNotFoundException", () =>
        Effect.succeed("gone" as const),
      ),
    );
    if (result === "present") {
      return yield* Effect.fail(
        new Error(`Partnership '${partnershipId}' still exists`),
      );
    }
  }).pipe(
    Effect.retry({
      schedule: Schedule.max([Schedule.fixed("2 seconds"), Schedule.recurs(8)]),
    }),
  );

// The full chain (profile → transformer → capability → partnership) is
// credential-free, so the lifecycle runs ungated.
test.provider(
  "create, update, and destroy a B2BI partnership",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      // Create.
      const created = yield* stack.deploy(
        partnershipProgram("alchemy-b2bi-partnership"),
      );
      expect(created.partnershipId).toMatch(/^ps-/);
      expect(created.profileId).toMatch(/^p-/);
      expect(created.partnershipArn).toContain(":b2bi:");

      // Out-of-band verification.
      const described = yield* b2bi.getPartnership({
        partnershipId: created.partnershipId,
      });
      expect(described.name).toBe("alchemy-b2bi-partnership");
      expect(described.capabilities ?? []).toHaveLength(1);

      // Update the partnership name in place.
      const updated = yield* stack.deploy(
        partnershipProgram("alchemy-b2bi-partnership-renamed"),
      );
      expect(updated.partnershipId).toBe(created.partnershipId);
      const reDescribed = yield* b2bi.getPartnership({
        partnershipId: created.partnershipId,
      });
      expect(reDescribed.name).toBe("alchemy-b2bi-partnership-renamed");

      // Destroy the whole chain and verify.
      yield* stack.destroy();
      yield* assertPartnershipGone(created.partnershipId);
    }),
  { timeout: 150_000 },
);

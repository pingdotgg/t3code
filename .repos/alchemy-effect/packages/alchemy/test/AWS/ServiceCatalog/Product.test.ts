import * as AWS from "@/AWS";
import { Bucket } from "@/AWS/S3";
import { Product } from "@/AWS/ServiceCatalog";
import * as Test from "@/Test/Alchemy";
import * as s3 from "@distilled.cloud/aws/s3";
import * as servicecatalog from "@distilled.cloud/aws/service-catalog";
import { expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: AWS.providers() });

// Minimal valid CloudFormation template (a no-op resource) for the
// provisioning artifact. Generated once and inlined — never at deploy time.
const TEMPLATE = JSON.stringify({
  AWSTemplateFormatVersion: "2010-09-09",
  Description: "alchemy Service Catalog product test template",
  Resources: {
    NoOp: { Type: "AWS::CloudFormation::WaitConditionHandle" },
  },
});

class ProductStillExists extends Data.TaggedError("ProductStillExists")<{
  productId: string;
}> {}

const assertProductGone = (productId: string) =>
  servicecatalog.describeProductAsAdmin({ Id: productId }).pipe(
    Effect.flatMap(() => Effect.fail(new ProductStillExists({ productId }))),
    Effect.catchTag("ResourceNotFoundException", () => Effect.void),
    Effect.retry({
      while: (e) => e._tag === "ProductStillExists",
      schedule: Schedule.max([
        Schedule.fixed("2 seconds"),
        Schedule.recurs(10),
      ]),
    }),
  );

test.provider(
  "creates, updates, and deletes a CloudFormation product",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      // Phase 1: a bucket to host the CloudFormation template. The template
      // must exist in S3 before the product can be created.
      const phase1 = yield* stack.deploy(
        Effect.gen(function* () {
          const bucket = yield* Bucket("TemplateBucket", {
            forceDestroy: true,
          });
          return { bucketName: bucket.bucketName, region: bucket.region };
        }),
      );
      yield* s3.putObject({
        Bucket: phase1.bucketName,
        Key: "product-template.json",
        Body: new TextEncoder().encode(TEMPLATE),
        ContentType: "application/json",
      });
      const templateUrl = `https://${phase1.bucketName}.s3.${phase1.region}.amazonaws.com/product-template.json`;

      // Phase 2: the product itself.
      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const bucket = yield* Bucket("TemplateBucket", {
            forceDestroy: true,
          });
          const product = yield* Product("TestProduct", {
            owner: "alchemy-tests",
            description: "product lifecycle test",
            provisioningArtifact: {
              name: "v1",
              description: "initial version",
              templateUrl,
            },
            tags: { purpose: "lifecycle" },
          });
          return {
            bucketName: bucket.bucketName,
            productId: product.productId,
            productName: product.productName,
            provisioningArtifactId: product.provisioningArtifactId,
          };
        }),
      );
      expect(created.productId).toMatch(/^prod-/);
      expect(created.provisioningArtifactId).toMatch(/^pa-/);

      // out-of-band verify via distilled
      const described = yield* servicecatalog.describeProductAsAdmin({
        Id: created.productId,
      });
      const summary = described.ProductViewDetail?.ProductViewSummary;
      expect(summary?.Name).toBe(created.productName);
      expect(summary?.Owner).toBe("alchemy-tests");
      expect(summary?.Type).toBe("CLOUD_FORMATION_TEMPLATE");
      expect(described.ProvisioningArtifactSummaries?.[0]?.Name).toBe("v1");
      const tags = Object.fromEntries(
        (described.Tags ?? []).map((t) => [t.Key, t.Value]),
      );
      expect(tags.purpose).toBe("lifecycle");
      expect(tags["alchemy::id"]).toBe("TestProduct");

      // Phase 3: in-place update of owner, support info, and the artifact's
      // mutable fields (same template URL → no replacement).
      yield* stack.deploy(
        Effect.gen(function* () {
          yield* Bucket("TemplateBucket", { forceDestroy: true });
          yield* Product("TestProduct", {
            owner: "alchemy-tests-updated",
            description: "updated product description",
            supportEmail: "support@example.com",
            provisioningArtifact: {
              name: "v1",
              description: "updated version description",
              templateUrl,
            },
            tags: { purpose: "lifecycle-updated" },
          });
        }),
      );
      const updated = yield* servicecatalog.describeProductAsAdmin({
        Id: created.productId,
      });
      const updatedSummary = updated.ProductViewDetail?.ProductViewSummary;
      // same product ID → updated in place, not replaced
      expect(updatedSummary?.ProductId).toBe(created.productId);
      expect(updatedSummary?.Owner).toBe("alchemy-tests-updated");
      expect(updatedSummary?.SupportEmail).toBe("support@example.com");
      expect(updated.ProvisioningArtifactSummaries?.[0]?.Description).toBe(
        "updated version description",
      );
      const updatedTags = Object.fromEntries(
        (updated.Tags ?? []).map((t) => [t.Key, t.Value]),
      );
      expect(updatedTags.purpose).toBe("lifecycle-updated");

      yield* stack.destroy();
      yield* assertProductGone(created.productId);
    }),
  { timeout: 240_000 },
);

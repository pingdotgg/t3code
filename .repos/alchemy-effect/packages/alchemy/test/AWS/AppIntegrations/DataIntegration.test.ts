import * as AWS from "@/AWS";
import { DataIntegration } from "@/AWS/AppIntegrations";
import { Key } from "@/AWS/KMS";
import { Bucket } from "@/AWS/S3";
import * as Output from "@/Output";
import * as Test from "@/Test/Alchemy";
import * as appintegrations from "@distilled.cloud/aws/appintegrations";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: AWS.providers() });

// Ungated typed-error probe: prove the distilled error union carries the
// not-found tag this provider's read/delete paths depend on.
test.provider(
  "getDataIntegration on a nonexistent id fails with ResourceNotFoundException",
  () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        appintegrations.getDataIntegration({
          Identifier: "00000000-0000-0000-0000-000000000000",
        }),
      );
      expect(error._tag).toBe("ResourceNotFoundException");
    }),
);

const assertGone = (id: string) =>
  appintegrations.getDataIntegration({ Identifier: id }).pipe(
    Effect.flatMap(() =>
      Effect.fail(new Error(`data integration '${id}' still exists`)),
    ),
    Effect.catchTag("ResourceNotFoundException", () => Effect.void),
    Effect.retry({
      schedule: Schedule.max([
        Schedule.fixed("2 seconds"),
        Schedule.recurs(10),
      ]),
    }),
  );

test.provider(
  "create an S3 data integration, update description, delete",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { integration } = yield* stack.deploy(
        Effect.gen(function* () {
          const bucket = yield* Bucket("Content", { forceDestroy: true });
          const key = yield* Key("ContentKey", {
            description: "alchemy appintegrations test key",
            deletionWindow: "7 days",
          });
          const integration = yield* DataIntegration("ContentIntegration", {
            kmsKey: key.keyArn,
            sourceURI: Output.interpolate`s3://${bucket.bucketName}`,
            description: "alchemy data integration",
            tags: { purpose: "alchemy-test" },
          });
          return { integration };
        }),
      );

      expect(integration.dataIntegrationId).toBeDefined();
      expect(integration.dataIntegrationArn).toContain(":data-integration/");
      expect(integration.sourceURI).toMatch(/^s3:\/\//);

      // Out-of-band verification via distilled.
      const observed = yield* appintegrations.getDataIntegration({
        Identifier: integration.dataIntegrationId,
      });
      expect(observed.Name).toBe(integration.dataIntegrationName);
      expect(observed.Description).toBe("alchemy data integration");
      expect(observed.SourceURI).toBe(integration.sourceURI);
      expect(observed.KmsKey).toBe(integration.kmsKey);
      expect(observed.Tags?.purpose).toBe("alchemy-test");

      // Update the description in place (id/arn stable).
      const { integration: updated } = yield* stack.deploy(
        Effect.gen(function* () {
          const bucket = yield* Bucket("Content", { forceDestroy: true });
          const key = yield* Key("ContentKey", {
            description: "alchemy appintegrations test key",
            deletionWindow: "7 days",
          });
          const integration = yield* DataIntegration("ContentIntegration", {
            kmsKey: key.keyArn,
            sourceURI: Output.interpolate`s3://${bucket.bucketName}`,
            description: "alchemy data integration v2",
            tags: { purpose: "alchemy-test", phase: "two" },
          });
          return { integration };
        }),
      );
      expect(updated.dataIntegrationId).toBe(integration.dataIntegrationId);
      expect(updated.dataIntegrationArn).toBe(integration.dataIntegrationArn);

      const reobserved = yield* appintegrations.getDataIntegration({
        Identifier: integration.dataIntegrationId,
      });
      expect(reobserved.Description).toBe("alchemy data integration v2");
      expect(reobserved.Tags?.phase).toBe("two");

      yield* stack.destroy();
      yield* assertGone(integration.dataIntegrationId);
    }),
  { timeout: 240_000 },
);

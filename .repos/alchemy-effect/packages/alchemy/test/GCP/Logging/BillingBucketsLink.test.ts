import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as logging from "@distilled.cloud/gcp/logging_v2";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: GCP.providers() });

// Billing-account-scoped: set GOOGLE_BILLING_ACCOUNT when the credentials
// administer the billing account (the testing service account does not).
const billingAccountId = process.env.GOOGLE_BILLING_ACCOUNT?.trim().replace(
  /^billingAccounts\//,
  "",
);
const account = billingAccountId ?? "";

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const waitUntilGone = (name: string) =>
  logging.getBillingAccountsLocationsBucketsLinks({ name }).pipe(
    Effect.map((link) =>
      link.lifecycleState === "DELETE_REQUESTED"
        ? ("gone" as const)
        : ("found" as const),
    ),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("2 seconds"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider.skipIf(!billingAccountId)(
  "getBillingAccountsLocationsBucketsLinks on a missing link fails with NotFound",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        logging.getBillingAccountsLocationsBucketsLinks({
          name: `billingAccounts/${account}/locations/global/buckets/_Default/links/alchemy_missing`,
        }),
      );
      expect(error._tag).toEqual("NotFound");

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:logging", "live"], timeout: 90_000 },
);

test.provider.skipIf(!billingAccountId)(
  "create, replace, and delete a billing bucket link",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const bucket = yield* GCP.Logging.BillingBucket("AppLogs", {
            billingAccountId: account,
            analyticsEnabled: true,
            description: "analytics parent",
          });
          const link = yield* GCP.Logging.BillingBucketsLink("Analytics", {
            billingAccountId: account,
            location: bucket.location,
            bucketId: bucket.bucketId,
            description: "log analytics",
          });
          return { bucket, link };
        }),
      );

      expect(created.link.linkId).toEqual(expect.any(String));
      expect(created.link.bucketId).toEqual(created.bucket.bucketId);
      expect(created.link.description).toEqual("log analytics");

      const fetched = yield* logging.getBillingAccountsLocationsBucketsLinks({
        name: created.link.name,
      });
      expect(fetched.description).toContain("alchemy-id=");

      const nextLinkId = `${created.link.linkId.replace(/[^a-z0-9_]/g, "_")}_z`;

      const replaced = yield* stack.deploy(
        Effect.gen(function* () {
          const bucket = yield* GCP.Logging.BillingBucket("AppLogs", {
            billingAccountId: account,
            bucketId: created.bucket.bucketId,
            location: created.bucket.location,
            analyticsEnabled: true,
            description: "analytics parent",
          });
          const link = yield* GCP.Logging.BillingBucketsLink("Analytics", {
            billingAccountId: account,
            location: bucket.location,
            bucketId: bucket.bucketId,
            linkId: nextLinkId,
            description: "replaced link",
          });
          return { bucket, link };
        }),
      );

      expect(replaced.link.linkId).not.toEqual(created.link.linkId);

      const previousGone = yield* waitUntilGone(created.link.name);
      expect(previousGone).toEqual("gone");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(replaced.link.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:logging", "live"], timeout: 120_000 },
);

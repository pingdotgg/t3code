import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as logging from "@distilled.cloud/gcp/logging_v2";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: GCP.providers() });

// Organization-scoped: set GOOGLE_ORGANIZATION_ID when the credentials
// administer the organization (the testing service account does not).
const organizationId = process.env.GOOGLE_ORGANIZATION_ID?.trim().replace(
  /^organizations\//,
  "",
);
const organization = `organizations/${organizationId}`;

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const waitUntilGone = (name: string) =>
  logging.getOrganizationsLocationsBucketsLinks({ name }).pipe(
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

test.provider.skipIf(!organizationId)(
  "getOrganizationsLocationsBucketsLinks on a missing link fails with NotFound",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        logging.getOrganizationsLocationsBucketsLinks({
          name: `${organization}/locations/global/buckets/_Default/links/alchemy_missing`,
        }),
      );
      expect(error._tag).toEqual("NotFound");

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:logging", "live"], timeout: 90_000 },
);

test.provider.skipIf(!organizationId || !!process.env.FAST)(
  "create, replace, and delete an organization logging bucket link",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const bucket = yield* GCP.Logging.OrganizationLogBucket("Analytics", {
            organization,
            analyticsEnabled: true,
            description: "analytics parent",
          });
          const link = yield* GCP.Logging.OrganizationBucketsLink("Bq", {
            organization,
            bucket: bucket.name,
            description: "log analytics dataset",
          });
          return { bucket, link };
        }),
      );

      expect(created.link.linkId).toEqual(expect.any(String));
      expect(created.link.bucket).toEqual(created.bucket.name);
      expect(created.link.name).toEqual(
        `${created.bucket.name}/links/${created.link.linkId}`,
      );
      expect(created.link.description).toEqual("log analytics dataset");

      const fetched = yield* logging.getOrganizationsLocationsBucketsLinks({
        name: created.link.name,
      });
      expect(fetched.description).toContain("alchemy-id=");

      const last = created.link.linkId.at(-1) ?? "a";
      const nextLinkId = `${created.link.linkId.slice(0, -1)}${last === "z" ? "0" : "a"}`;

      const replaced = yield* stack.deploy(
        Effect.gen(function* () {
          const bucket = yield* GCP.Logging.OrganizationLogBucket("Analytics", {
            organization,
            bucketId: created.bucket.bucketId,
            location: created.bucket.location,
            analyticsEnabled: true,
            description: "analytics parent",
          });
          const link = yield* GCP.Logging.OrganizationBucketsLink("Bq", {
            organization,
            bucket: bucket.name,
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
  { tags: ["provider:gcp", "provider:gcp:logging", "live"], timeout: 90_000 },
);

import { GcpEnvironment } from "@/GCP/Environment";
import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as apigee from "@distilled.cloud/gcp/apigee_v1";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: GCP.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const siteId = process.env.GCP_TEST_APIGEE_SITE ?? "";

// Needs a provisioned Apigee organization on the testing project (paid, or
// ~1h eval provisioning); without one calls fail with ApigeeResourceNotFound (403 "Permission
// denied on resource \"organizations/{project}\" (or it may not exist)").
// Set GCP_TEST_APIGEE_ORG=1 when the org exists.
const runLifecycle = !!process.env.GCP_TEST_APIGEE_ORG && !!siteId;

const waitUntilGone = (name: string) =>
  apigee.getOrganizationsSitesApicategories({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag(["NotFound", "ApigeeResourceNotFound"], () =>
      Effect.succeed("gone" as const),
    ),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider(
  "getOrganizationsSitesApicategories on a missing category fails with ApigeeResourceNotFound",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;

      yield* stack.destroy();

      const error = yield* Effect.flip(
        apigee.getOrganizationsSitesApicategories({
          name: `organizations/${project}/sites/alchemy-missing-site/apicategories/alchemy-missing-category`,
        }),
      );
      expect(error._tag).toEqual("ApigeeResourceNotFound");

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:apigee", "live"], timeout: 90_000 },
);

test.provider.skipIf(!runLifecycle)(
  "create, update, and delete an Apigee API category",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;

      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Apigee.SitesApicategory("Payments", {
            siteId,
            name: "Payments",
          });
        }),
      );

      expect(created.categoryId).toEqual(expect.any(String));
      expect(created.organization).toEqual(project);
      expect(created.siteId).toEqual(siteId);
      expect(created.categoryName).toEqual("Payments");
      expect(created.name).toEqual(
        `organizations/${project}/sites/${siteId}/apicategories/${created.categoryId}`,
      );

      const fetched = yield* apigee.getOrganizationsSitesApicategories({
        name: created.name,
      });
      expect(fetched.data?.id).toEqual(created.categoryId);
      expect(fetched.data?.name).toEqual("Payments");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Apigee.SitesApicategory("Payments", {
            siteId,
            name: "Billing",
          });
        }),
      );

      expect(updated.categoryId).toEqual(created.categoryId);
      expect(updated.categoryName).toEqual("Billing");

      const fetchedUpdate = yield* apigee.getOrganizationsSitesApicategories({
        name: updated.name,
      });
      expect(fetchedUpdate.data?.name).toEqual("Billing");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:apigee", "live"], timeout: 90_000 },
);

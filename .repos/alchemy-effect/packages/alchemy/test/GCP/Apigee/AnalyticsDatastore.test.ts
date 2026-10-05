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

// Needs a provisioned Apigee organization on the testing project (paid, or
// ~1h eval provisioning); without one calls fail with ApigeeResourceNotFound (403 "Permission
// denied on resource \"organizations/{project}\" (or it may not exist)").
// Set GCP_TEST_APIGEE_ORG=1 when the org exists.
const runLifecycle = !!process.env.GCP_TEST_APIGEE_ORG;

const waitUntilGone = (name: string) =>
  apigee.getOrganizationsAnalyticsDatastores({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.catchTag("ApigeeResourceNotFound", () =>
      Effect.succeed("gone" as const),
    ),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider(
  "getOrganizationsAnalyticsDatastores on a missing datastore fails with ApigeeResourceNotFound",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;
      const org = `organizations/${project}`;

      yield* stack.destroy();

      const error = yield* Effect.flip(
        apigee.getOrganizationsAnalyticsDatastores({
          name: `${org}/analytics/datastores/alchemy-missing`,
        }),
      );
      expect(error._tag).toEqual("ApigeeResourceNotFound");

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:apigee", "live"], timeout: 90_000 },
);

test.provider.skipIf(!runLifecycle)(
  "create, update, and delete an analytics datastore",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;

      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Apigee.AnalyticsDatastore("Exports", {
            targetType: "gcs",
            displayName: "alchemy exports",
            datastoreConfig: {
              projectId: project,
              bucketName: "apigee-analytics",
              path: "exports",
            },
          });
        }),
      );

      expect(created.datastoreId).toEqual(expect.any(String));
      expect(created.displayName).toEqual("alchemy exports");
      expect(created.targetType).toEqual("gcs");

      const fetched = yield* apigee.getOrganizationsAnalyticsDatastores({
        name: created.name,
      });
      expect(fetched.displayName).toContain("alchemy-id=");
      expect(fetched.displayName).toContain("alchemy exports");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Apigee.AnalyticsDatastore("Exports", {
            targetType: "gcs",
            displayName: "alchemy exports updated",
            datastoreConfig: {
              projectId: project,
              bucketName: "apigee-analytics",
              path: "exports-v2",
            },
          });
        }),
      );

      expect(updated.datastoreId).toEqual(created.datastoreId);
      expect(updated.displayName).toEqual("alchemy exports updated");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:apigee", "live"], timeout: 90_000 },
);

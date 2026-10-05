import * as GCP from "@/GCP";
import { GcpEnvironment } from "@/GCP/Environment";
import * as Test from "@/Test/Alchemy";
import * as rma from "@distilled.cloud/gcp/rapidmigrationassessment_v1";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: GCP.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);
// The Rapid Migration Assessment API is disabled on the testing project
// (every call fails with ServiceDisabled). Set GCP_TEST_RMA=1 on a project
// with the API enabled.
const runLifecycle = !!process.env.GCP_TEST_RMA && !process.env.FAST;

const waitUntilGone = (name: string) =>
  rma.getProjectsLocationsCollectors({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("2 seconds"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider.skipIf(runLifecycle)(
  "getProjectsLocationsCollectors on a missing collector fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;
      const parent = `projects/${project}/locations/us-central1`;
      const missingName = `${parent}/collectors/alchemy-missing-collector`;
      yield* stack.destroy();

      const error = yield* Effect.flip(
        rma.getProjectsLocationsCollectors({ name: missingName }),
      );
      expect(error._tag).toEqual("ServiceDisabled");

      yield* stack.destroy();
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:rapidmigrationassessment", "live"],
    timeout: 90_000,
  },
);

test.provider.skipIf(runLifecycle)(
  "createProjectsLocationsCollectors is rejected with ServiceDisabled when Rapid Migration Assessment is disabled",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;
      const parent = `projects/${project}/locations/us-central1`;
      const serviceAccount = `alchemy-testing@${project}.iam.gserviceaccount.com`;
      yield* stack.destroy();

      const error = yield* Effect.flip(
        rma.createProjectsLocationsCollectors({
          parent,
          collectorId: "alchemyrmaprobe",
          body: {
            displayName: "alchemy-probe",
            collectionDays: 7,
            expectedAssetCount: "1",
            serviceAccount,
          },
        }),
      );
      expect(error._tag).toEqual("ServiceDisabled");

      yield* stack.destroy();
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:rapidmigrationassessment", "live"],
    timeout: 90_000,
  },
);

test.provider.skipIf(!runLifecycle)(
  "create, update, and delete a collector",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;
      const parent = `projects/${project}/locations/us-central1`;
      const missingName = `${parent}/collectors/alchemy-missing-collector`;
      const serviceAccount = `alchemy-testing@${project}.iam.gserviceaccount.com`;
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.RapidMigrationAssessment.Collector("OnPrem", {
            location: "us-central1",
            displayName: "on-prem collector",
            description: "inventory appliance",
            collectionDays: 7,
            expectedAssetCount: 10,
            serviceAccount,
            labels: { env: "test" },
          });
        }),
      );

      expect(created.collectorId).toEqual(expect.any(String));
      expect(created.name).toEqual(
        `${parent}/collectors/${created.collectorId}`,
      );
      expect(created.project).toEqual(project);
      expect(created.location).toEqual("us-central1");
      expect(created.displayName).toEqual("on-prem collector");
      expect(created.description).toEqual("inventory appliance");
      expect(created.collectionDays).toEqual(7);
      expect(created.labels).toMatchObject({ env: "test" });

      const fetched = yield* rma.getProjectsLocationsCollectors({
        name: created.name,
      });
      expect(fetched.name).toEqual(created.name);
      expect(fetched.displayName).toEqual("on-prem collector");
      expect(fetched.labels?.env).toEqual("test");
      expect(fetched.labels?.["alchemy-id"]).toEqual(expect.any(String));
      expect(fetched.collectionDays).toEqual(7);

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.RapidMigrationAssessment.Collector("OnPrem", {
            collectorId: created.collectorId,
            location: "us-central1",
            displayName: "on-prem collector v2",
            description: "inventory appliance v2",
            collectionDays: 14,
            expectedAssetCount: 25,
            serviceAccount,
            labels: { env: "prod", role: "rma" },
          });
        }),
      );

      expect(updated.name).toEqual(created.name);
      expect(updated.collectorId).toEqual(created.collectorId);
      expect(updated.displayName).toEqual("on-prem collector v2");
      expect(updated.description).toEqual("inventory appliance v2");
      expect(updated.collectionDays).toEqual(14);
      expect(updated.labels).toMatchObject({ env: "prod", role: "rma" });

      const fetchedUpdate = yield* rma.getProjectsLocationsCollectors({
        name: created.name,
      });
      expect(fetchedUpdate.displayName).toEqual("on-prem collector v2");
      expect(fetchedUpdate.collectionDays).toEqual(14);
      expect(fetchedUpdate.labels?.env).toEqual("prod");
      expect(fetchedUpdate.labels?.role).toEqual("rma");

      yield* stack.destroy();
      const gone = yield* waitUntilGone(created.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:rapidmigrationassessment", "live"],
    timeout: 120_000,
  },
);

import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as migrationcenter from "@distilled.cloud/gcp/migrationcenter_v1";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import { GcpEnvironment } from "@/GCP/Environment";

const { test } = Test.make({ providers: GCP.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const waitUntilGone = (name: string) =>
  migrationcenter.getProjectsLocationsAssetsExportJobs({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider(
  "getProjectsLocationsAssetsExportJobs on a missing job fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;
      yield* stack.destroy();

      const error = yield* Effect.flip(
        migrationcenter.getProjectsLocationsAssetsExportJobs({
          name: `projects/${project}/locations/us-central1/assetsExportJobs/alchemy-missing-export`,
        }),
      );
      expect(error._tag).toEqual("NotFound");

      yield* stack.destroy();
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:migrationcenter", "live"],
    timeout: 90_000,
  },
);

test.provider(
  "create, replace, and delete a migration center assets export job",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.MigrationCenter.AssetsExportJob("Inventory", {
            location: "us-central1",
            fileFormat: "CSV",
            labels: { env: "test" },
          });
        }),
      );

      expect(created.assetsExportJobId).toEqual(expect.any(String));
      expect(created.name).toEqual(
        `projects/${project}/locations/us-central1/assetsExportJobs/${created.assetsExportJobId}`,
      );
      expect(created.fileFormat).toEqual("CSV");
      expect(created.inventory).toEqual(true);
      expect(created.labels).toMatchObject({ env: "test" });

      const fetched =
        yield* migrationcenter.getProjectsLocationsAssetsExportJobs({
          name: created.name,
        });
      expect(fetched.name).toEqual(created.name);
      expect(fetched.signedUriDestination?.fileFormat).toEqual("CSV");
      expect(fetched.labels?.env).toEqual("test");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.MigrationCenter.AssetsExportJob("Inventory", {
            assetsExportJobId: created.assetsExportJobId,
            location: "us-central1",
            fileFormat: "XLSX",
            labels: { env: "prod" },
          });
        }),
      );

      expect(updated.assetsExportJobId).toEqual(created.assetsExportJobId);
      expect(updated.fileFormat).toEqual("XLSX");
      expect(updated.labels).toMatchObject({ env: "prod" });

      const fetchedUpdate =
        yield* migrationcenter.getProjectsLocationsAssetsExportJobs({
          name: updated.name,
        });
      expect(fetchedUpdate.signedUriDestination?.fileFormat).toEqual("XLSX");
      expect(fetchedUpdate.labels?.env).toEqual("prod");

      yield* stack.destroy();
      const gone = yield* waitUntilGone(updated.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:migrationcenter", "live"],
    timeout: 90_000,
  },
);

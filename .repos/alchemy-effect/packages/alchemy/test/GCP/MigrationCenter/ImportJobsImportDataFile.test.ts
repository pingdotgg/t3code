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
  migrationcenter.getProjectsLocationsImportJobsImportDataFiles({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider(
  "getProjectsLocationsImportJobsImportDataFiles on a missing file fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;
      yield* stack.destroy();

      const error = yield* Effect.flip(
        migrationcenter.getProjectsLocationsImportJobsImportDataFiles({
          name: `projects/${project}/locations/us-central1/importJobs/alchemy-missing-job/importDataFiles/alchemy-missing-file`,
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
  "create and delete a migration center import data file",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const source = yield* GCP.MigrationCenter.Source("Upload", {
            location: "us-central1",
            type: "SOURCE_TYPE_UPLOAD",
            displayName: "file-source",
          });
          const job = yield* GCP.MigrationCenter.ImportJob("Rvtools", {
            location: "us-central1",
            assetSource: source.name,
            displayName: "file-import",
          });
          const file = yield* GCP.MigrationCenter.ImportJobsImportDataFile(
            "Payload",
            {
              importJob: job.name,
              location: "us-central1",
              format: "IMPORT_JOB_FORMAT_RVTOOLS_CSV",
              displayName: "inventory",
            },
          );
          return { source, job, file };
        }),
      );

      expect(created.file.importDataFileId).toEqual(expect.any(String));
      expect(created.file.importJob).toEqual(created.job.name);
      expect(created.file.format).toEqual("IMPORT_JOB_FORMAT_RVTOOLS_CSV");

      const fetched =
        yield* migrationcenter.getProjectsLocationsImportJobsImportDataFiles({
          name: created.file.name,
        });
      expect(fetched.name).toEqual(created.file.name);
      expect(fetched.format).toEqual("IMPORT_JOB_FORMAT_RVTOOLS_CSV");
      expect(fetched.displayName).toContain("alchemy-id=");

      yield* stack.destroy();
      const gone = yield* waitUntilGone(created.file.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:migrationcenter", "live"],
    timeout: 180_000,
  },
);

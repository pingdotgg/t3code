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
  migrationcenter.getProjectsLocationsImportJobs({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider(
  "getProjectsLocationsImportJobs on a missing job fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;
      yield* stack.destroy();

      const error = yield* Effect.flip(
        migrationcenter.getProjectsLocationsImportJobs({
          name: `projects/${project}/locations/us-central1/importJobs/alchemy-missing-import`,
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
  "create, update, and delete a migration center import job",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const source = yield* GCP.MigrationCenter.Source("Upload", {
            location: "us-central1",
            type: "SOURCE_TYPE_UPLOAD",
            displayName: "import-source",
          });
          const job = yield* GCP.MigrationCenter.ImportJob("Rvtools", {
            location: "us-central1",
            assetSource: source.name,
            displayName: "rvtools-import",
            labels: { env: "test" },
          });
          return { source, job };
        }),
      );

      expect(created.job.importJobId).toEqual(expect.any(String));
      expect(created.job.assetSource).toEqual(created.source.name);
      expect(created.job.displayName).toEqual("rvtools-import");
      expect(created.job.labels).toMatchObject({ env: "test" });

      const fetched = yield* migrationcenter.getProjectsLocationsImportJobs({
        name: created.job.name,
        view: "IMPORT_JOB_VIEW_FULL",
      });
      expect(fetched.name).toEqual(created.job.name);
      expect(fetched.assetSource).toEqual(created.source.name);
      expect(fetched.labels?.env).toEqual("test");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const source = yield* GCP.MigrationCenter.Source("Upload", {
            sourceId: created.source.sourceId,
            location: "us-central1",
            type: "SOURCE_TYPE_UPLOAD",
            displayName: "import-source",
          });
          const job = yield* GCP.MigrationCenter.ImportJob("Rvtools", {
            importJobId: created.job.importJobId,
            location: "us-central1",
            assetSource: source.name,
            displayName: "rvtools-import-v2",
            labels: { env: "prod" },
          });
          return { source, job };
        }),
      );

      expect(updated.job.name).toEqual(created.job.name);
      expect(updated.job.displayName).toEqual("rvtools-import-v2");
      expect(updated.job.labels).toMatchObject({ env: "prod" });

      yield* stack.destroy();
      const gone = yield* waitUntilGone(created.job.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:migrationcenter", "live"],
    timeout: 180_000,
  },
);

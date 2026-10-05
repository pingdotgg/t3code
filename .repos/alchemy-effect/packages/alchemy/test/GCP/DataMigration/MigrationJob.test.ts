import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as datamigration from "@distilled.cloud/gcp/datamigration_v1";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import {
  logLevel,
  currentProject,
  runSlowLifecycle,
  waitUntilGone,
} from "./common.ts";

const { test } = Test.make({ providers: GCP.providers() });

test.provider(
  "getProjectsLocationsMigrationJobs on a missing job fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      const project = yield* currentProject;

      yield* stack.destroy();

      const error = yield* Effect.flip(
        datamigration.getProjectsLocationsMigrationJobs({
          name: `projects/${project}/locations/us-central1/migrationJobs/alchemy-missing-job`,
        }),
      );
      expect(error._tag).toEqual("NotFound");

      yield* stack.destroy();
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:datamigration", "live"],
    timeout: 90_000,
  },
);

test.provider.skipIf(!runSlowLifecycle)(
  "create, update, and delete a mysql to cloudsql migration job",
  (stack) =>
    Effect.gen(function* () {
      const project = yield* currentProject;

      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const source = yield* GCP.DataMigration.ConnectionProfile(
            "MysqlSrc",
            {
              location: "us-central1",
              displayName: "job-src",
              mysql: {
                host: "10.0.0.8",
                port: 3306,
                username: "alchemy",
                password: "AlchemyTestPass1",
              },
            },
          );
          const dest = yield* GCP.DataMigration.ConnectionProfile("MysqlDest", {
            location: "us-central1",
            displayName: "job-dest",
            cloudsql: {
              settings: {
                sourceId: source.name,
                databaseVersion: "MYSQL_8_0",
                tier: "db-n1-standard-1",
                rootPassword: "AlchemyTestPass1",
                dataDiskSizeGb: "10",
              },
            },
          });
          const job = yield* GCP.DataMigration.MigrationJob("Replica", {
            location: "us-central1",
            displayName: "mysql-replica",
            labels: { env: "test" },
            type: "CONTINUOUS",
            source: source.name,
            destination: dest.name,
            staticIpConnectivity: {},
          });
          return { source, dest, job };
        }),
      );

      expect(created.job.migrationJobId).toEqual(expect.any(String));
      expect(created.job.name).toEqual(
        `projects/${project}/locations/us-central1/migrationJobs/${created.job.migrationJobId}`,
      );
      expect(created.job.type).toEqual("CONTINUOUS");
      expect(created.job.source).toEqual(created.source.name);
      expect(created.job.destination).toEqual(created.dest.name);
      expect(created.job.labels).toMatchObject({ env: "test" });

      const fetched = yield* datamigration.getProjectsLocationsMigrationJobs({
        name: created.job.name,
      });
      expect(fetched.name).toEqual(created.job.name);
      expect(fetched.displayName).toEqual("mysql-replica");
      expect(fetched.labels?.env).toEqual("test");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const source = yield* GCP.DataMigration.ConnectionProfile(
            "MysqlSrc",
            {
              connectionProfileId: created.source.connectionProfileId,
              location: "us-central1",
              displayName: "job-src",
              mysql: {
                host: "10.0.0.8",
                port: 3306,
                username: "alchemy",
              },
            },
          );
          const dest = yield* GCP.DataMigration.ConnectionProfile("MysqlDest", {
            connectionProfileId: created.dest.connectionProfileId,
            location: "us-central1",
            displayName: "job-dest",
            cloudsql: {
              settings: {
                sourceId: source.name,
                databaseVersion: "MYSQL_8_0",
                tier: "db-n1-standard-1",
                dataDiskSizeGb: "10",
              },
            },
          });
          const job = yield* GCP.DataMigration.MigrationJob("Replica", {
            migrationJobId: created.job.migrationJobId,
            location: "us-central1",
            displayName: "mysql-replica-v2",
            labels: { env: "prod", team: "dms" },
            type: "CONTINUOUS",
            source: source.name,
            destination: dest.name,
            staticIpConnectivity: {},
          });
          return { source, dest, job };
        }),
      );

      expect(updated.job.name).toEqual(created.job.name);
      expect(updated.job.displayName).toEqual("mysql-replica-v2");
      expect(updated.job.labels).toMatchObject({ env: "prod", team: "dms" });

      const fetchedUpdate =
        yield* datamigration.getProjectsLocationsMigrationJobs({
          name: updated.job.name,
        });
      expect(fetchedUpdate.displayName).toEqual("mysql-replica-v2");
      expect(fetchedUpdate.labels?.team).toEqual("dms");

      yield* stack.destroy();
      const gone = yield* waitUntilGone(
        datamigration.getProjectsLocationsMigrationJobs({
          name: created.job.name,
        }),
      );
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  // The Cloud SQL destination profile provisions an instance (20–40 minutes).
  {
    tags: ["provider:gcp", "provider:gcp:datamigration", "live"],
    timeout: 3_600_000,
    retry: 0,
  },
);

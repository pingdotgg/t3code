import { GcpEnvironment } from "@/GCP/Environment";
import { Action } from "@/Action";
import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as alloydb from "@distilled.cloud/gcp/alloydb_v1";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: GCP.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

// AlloyDB clusters and instances take well over 5 minutes to provision.
const runLifecycle = !!process.env.GCP_TEST_SLOW && !process.env.FAST;

const waitUntilGone = (name: string) =>
  alloydb.getProjectsLocationsBackups({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("2 seconds"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider(
  "getProjectsLocationsBackups on a missing backup fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;

      yield* stack.destroy();

      const error = yield* Effect.flip(
        alloydb.getProjectsLocationsBackups({
          name: `projects/${project}/locations/us-central1/backups/alchemy-alloydb-missing`,
        }),
      );
      expect(error._tag).toEqual("NotFound");

      const page = yield* alloydb.listProjectsLocationsBackups({
        parent: `projects/${project}/locations/-`,
        pageSize: 10,
      });
      expect((page.backups ?? []).map((item) => item.name)).not.toContain(
        `projects/${project}/locations/us-central1/backups/alchemy-alloydb-missing`,
      );

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:alloydb", "live"], timeout: 90_000 },
);

test.provider.skipIf(!runLifecycle)(
  "create, update, and delete an alloydb backup",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const cluster = yield* GCP.AlloyDB.Cluster("AppDb", {
            location: "us-central1",
            pscConfig: { pscEnabled: true },
            displayName: "alchemy-test-backup-cluster",
            labels: { env: "test" },
            initialUser: { user: "postgres", password: "AlchemyTest1" },
            automatedBackupPolicy: { enabled: false },
            continuousBackupConfig: { enabled: false },
          });
          // AlloyDB only backs up clusters with a primary instance.
          const instance = yield* GCP.AlloyDB.Instance("Primary", {
            cluster: cluster.name,
            instanceType: "PRIMARY",
            machineConfig: { cpuCount: 2 },
          });
          const backup = yield* GCP.AlloyDB.Backup("OnDemand", {
            clusterName: instance.clusterName,
            displayName: "alchemy-test-backup",
            description: "test snapshot",
            labels: { env: "test" },
          });
          const Probe = Action(
            "Probe",
            Effect.gen(function* () {
              const getBackup = yield* GCP.AlloyDB.GetBackup(backup);
              return Effect.fn(function* () {
                return yield* getBackup();
              });
            }),
          );
          return { cluster, backup, probe: yield* Probe({}) };
        }),
      );

      expect(created.backup.name).toContain("/backups/");
      expect(created.backup.clusterId).toEqual(created.cluster.clusterId);
      expect(created.backup.location).toEqual("us-central1");
      expect(created.backup.displayName).toEqual("alchemy-test-backup");
      expect(created.backup.description).toEqual("test snapshot");
      expect(created.backup.labels).toMatchObject({ env: "test" });
      expect(created.backup.type).toEqual("ON_DEMAND");
      expect(created.backup.state).toEqual("READY");
      expect(created.probe.name).toEqual(created.backup.name);

      const fetched = yield* alloydb.getProjectsLocationsBackups({
        name: created.backup.name,
      });
      expect(fetched.name).toEqual(created.backup.name);
      // GCP omits displayName from backup reads; the attributes carry it.
      expect(fetched.labels?.env).toEqual("test");
      expect(fetched.type).toEqual("ON_DEMAND");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const cluster = yield* GCP.AlloyDB.Cluster("AppDb", {
            clusterId: created.cluster.clusterId,
            location: "us-central1",
            pscConfig: { pscEnabled: true },
            displayName: "alchemy-test-backup-cluster",
            labels: { env: "test" },
            automatedBackupPolicy: { enabled: false },
            continuousBackupConfig: { enabled: false },
          });
          const instance = yield* GCP.AlloyDB.Instance("Primary", {
            cluster: cluster.name,
            instanceType: "PRIMARY",
            machineConfig: { cpuCount: 2 },
          });
          const backup = yield* GCP.AlloyDB.Backup("OnDemand", {
            clusterName: instance.clusterName,
            backupId: created.backup.backupId,
            displayName: "alchemy-prod-backup",
            // Description is create-only (a change replaces the backup), so
            // this step only changes fields that update in place.
            description: "test snapshot",
            labels: { env: "prod", role: "backup" },
          });
          return { cluster, backup };
        }),
      );

      expect(updated.backup.name).toEqual(created.backup.name);
      expect(updated.backup.displayName).toEqual("alchemy-prod-backup");
      expect(updated.backup.description).toEqual("test snapshot");
      expect(updated.backup.labels).toMatchObject({
        env: "prod",
        role: "backup",
      });

      const refetched = yield* alloydb.getProjectsLocationsBackups({
        name: created.backup.name,
      });
      // GCP omits displayName from backup reads; the attributes carry it.
      expect(refetched.description).toEqual("test snapshot");
      expect(refetched.labels?.env).toEqual("prod");
      expect(refetched.labels?.role).toEqual("backup");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.backup.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:alloydb", "live"],
    timeout: 3_600_000,
    retry: 0,
  },
);

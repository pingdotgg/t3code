import { GcpEnvironment } from "@/GCP/Environment";
import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as bigtable from "@distilled.cloud/gcp/bigtableadmin_v2";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: GCP.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

// Lifecycles provision a Bigtable instance; skipped with --fast.
const runLifecycle = !process.env.FAST;

const expireInDays = (days: number) =>
  new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();

const waitUntilGone = (name: string) =>
  bigtable.getProjectsInstancesClustersBackups({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("2 seconds"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider(
  "getProjectsInstancesClustersBackups on a missing instance fails with NotFound",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;

      yield* stack.destroy();

      const error = yield* Effect.flip(
        bigtable.getProjectsInstancesClustersBackups({
          name: `projects/${project}/instances/alchemybtmissing/clusters/cluster/backups/missing`,
        }),
      );
      expect(error._tag).toEqual("NotFound");

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:bigtable", "live"], timeout: 90_000 },
);

test.provider.skipIf(!runLifecycle)(
  "create, update, and delete a bigtable backup",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const firstExpire = expireInDays(8);
      const secondExpire = expireInDays(14);

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const instance = yield* GCP.Bigtable.Instance("Data", {
            displayName: "alchemy-test-bt-backup",
            type: "PRODUCTION",
            clusters: {
              cluster: {
                location: "us-central1-b",
                serveNodes: 1,
                defaultStorageType: "HDD",
              },
            },
          });
          const table = yield* GCP.Bigtable.Table("Users", {
            instance: instance.name,
            columnFamilies: { cf: { gcRule: { maxNumVersions: 1 } } },
          });
          const backup = yield* GCP.Bigtable.InstancesClustersBackup(
            "Nightly",
            {
              instance: instance.name,
              cluster: "cluster",
              sourceTable: table.name,
              expireTime: firstExpire,
            },
          );
          return { instance, table, backup };
        }),
      );

      expect(created.backup.name).toContain("/backups/");
      expect(created.backup.backupId).toEqual(expect.any(String));
      expect(created.backup.instance).toEqual(created.instance.name);
      expect(created.backup.sourceTable).toEqual(created.table.name);
      expect(created.backup.state).toEqual("READY");

      const fetched = yield* bigtable.getProjectsInstancesClustersBackups({
        name: created.backup.name,
      });
      expect(fetched.name).toEqual(created.backup.name);
      expect(fetched.sourceTable).toEqual(created.table.name);
      expect(fetched.state).toEqual("READY");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const instance = yield* GCP.Bigtable.Instance("Data", {
            instanceId: created.instance.instanceId,
            displayName: "alchemy-test-bt-backup",
            type: "PRODUCTION",
            clusters: {
              cluster: {
                location: "us-central1-b",
                serveNodes: 1,
                defaultStorageType: "HDD",
              },
            },
          });
          const table = yield* GCP.Bigtable.Table("Users", {
            instance: instance.name,
            tableId: created.table.tableId,
            columnFamilies: { cf: { gcRule: { maxNumVersions: 1 } } },
          });
          const backup = yield* GCP.Bigtable.InstancesClustersBackup(
            "Nightly",
            {
              instance: instance.name,
              cluster: "cluster",
              sourceTable: table.name,
              backupId: created.backup.backupId,
              expireTime: secondExpire,
            },
          );
          return { instance, table, backup };
        }),
      );

      expect(updated.backup.name).toEqual(created.backup.name);
      expect(updated.backup.expireTime).toBeDefined();

      const refetched = yield* bigtable.getProjectsInstancesClustersBackups({
        name: created.backup.name,
      });
      expect(refetched.name).toEqual(created.backup.name);
      expect(refetched.expireTime).toBeDefined();

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.backup.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:bigtable", "live"], timeout: 120_000 },
);

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

const runLifecycle = !process.env.FAST;

const waitUntilGone = (name: string) =>
  bigtable.getProjectsInstancesTables({ name, view: "NAME_ONLY" }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("2 seconds"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider(
  "getProjectsInstancesTables on a missing instance fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;

      yield* stack.destroy();

      const error = yield* Effect.flip(
        bigtable.getProjectsInstancesTables({
          name: `projects/${project}/instances/alchemybtmissing/tables/missing`,
        }),
      );
      expect(error._tag).toEqual("NotFound");

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:bigtable", "live"], timeout: 90_000 },
);

test.provider.skipIf(!runLifecycle)(
  "create, update, and delete a bigtable table",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const instance = yield* GCP.Bigtable.Instance("Data", {
            displayName: "alchemy-test-bt-table",
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
            columnFamilies: {
              cf: { gcRule: { maxNumVersions: 3 } },
            },
          });
          return { instance, table };
        }),
      );

      expect(created.table.name).toContain("/tables/");
      expect(created.table.tableId).toEqual(expect.any(String));
      expect(created.table.instance).toEqual(created.instance.name);
      expect(created.table.columnFamilies.cf?.gcRule?.maxNumVersions).toEqual(
        3,
      );
      expect(created.table.deletionProtection).toEqual(false);

      const fetched = yield* bigtable.getProjectsInstancesTables({
        name: created.table.name,
        view: "SCHEMA_VIEW",
      });
      expect(fetched.name).toEqual(created.table.name);
      expect(fetched.columnFamilies?.cf?.gcRule?.maxNumVersions).toEqual(3);

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const instance = yield* GCP.Bigtable.Instance("Data", {
            instanceId: created.instance.instanceId,
            displayName: "alchemy-test-bt-table",
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
            columnFamilies: {
              cf: { gcRule: { maxNumVersions: 5 } },
            },
          });
          return { instance, table };
        }),
      );

      expect(updated.table.name).toEqual(created.table.name);
      expect(updated.table.columnFamilies.cf?.gcRule?.maxNumVersions).toEqual(
        5,
      );

      const refetched = yield* bigtable.getProjectsInstancesTables({
        name: created.table.name,
        view: "SCHEMA_VIEW",
      });
      expect(refetched.columnFamilies?.cf?.gcRule?.maxNumVersions).toEqual(5);

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.table.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:bigtable", "live"], timeout: 120_000 },
);

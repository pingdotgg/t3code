import { GcpEnvironment } from "@/GCP/Environment";
import * as GCP from "@/GCP";
import * as Output from "@/Output";
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

const waitUntilGone = (name: string) =>
  bigtable.getProjectsInstancesMaterializedViews({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("2 seconds"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider(
  "getProjectsInstancesMaterializedViews on a missing instance fails with NotFound",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;

      yield* stack.destroy();

      const error = yield* Effect.flip(
        bigtable.getProjectsInstancesMaterializedViews({
          name: `projects/${project}/instances/alchemybtmissing/materializedViews/missing`,
        }),
      );
      expect(error._tag).toEqual("NotFound");

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:bigtable", "live"], timeout: 90_000 },
);

test.provider.skipIf(!runLifecycle)(
  "create, update, and delete a bigtable materialized view",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const instance = yield* GCP.Bigtable.Instance("Data", {
            displayName: "alchemy-test-bt-mview",
            type: "PRODUCTION",
            clusters: {
              cluster: {
                location: "us-central1-b",
                serveNodes: 1,
                defaultStorageType: "HDD",
              },
            },
          });
          const table = yield* GCP.Bigtable.Table("Events", {
            instance: instance.name,
            tableId: "events",
            columnFamilies: { cf: { gcRule: { maxNumVersions: 1 } } },
          });
          const view = yield* GCP.Bigtable.InstancesMaterializedView("Counts", {
            instance: instance.name,
            query: Output.interpolate`SELECT '*' AS _key, COUNT(*) AS row_count FROM \`${table.tableId}\` GROUP BY _key`,
          });
          return { instance, table, view };
        }),
      );

      expect(created.view.name).toContain("/materializedViews/");
      expect(created.view.materializedViewId).toEqual(expect.any(String));
      expect(created.view.instance).toEqual(created.instance.name);
      expect(created.view.query).toContain("events");
      expect(created.view.deletionProtection).toEqual(false);

      const fetched = yield* bigtable.getProjectsInstancesMaterializedViews({
        name: created.view.name,
      });
      expect(fetched.name).toEqual(created.view.name);

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const instance = yield* GCP.Bigtable.Instance("Data", {
            instanceId: created.instance.instanceId,
            displayName: "alchemy-test-bt-mview",
            type: "PRODUCTION",
            clusters: {
              cluster: {
                location: "us-central1-b",
                serveNodes: 1,
                defaultStorageType: "HDD",
              },
            },
          });
          const table = yield* GCP.Bigtable.Table("Events", {
            instance: instance.name,
            tableId: "events",
            columnFamilies: { cf: { gcRule: { maxNumVersions: 1 } } },
          });
          const view = yield* GCP.Bigtable.InstancesMaterializedView("Counts", {
            instance: instance.name,
            materializedViewId: created.view.materializedViewId,
            query: Output.interpolate`SELECT '*' AS _key, COUNT(*) AS row_count FROM \`${table.tableId}\` GROUP BY _key`,
            deletionProtection: true,
          });
          return { instance, table, view };
        }),
      );

      expect(updated.view.name).toEqual(created.view.name);
      expect(updated.view.deletionProtection).toEqual(true);

      const refetched = yield* bigtable.getProjectsInstancesMaterializedViews({
        name: created.view.name,
      });
      expect(refetched.deletionProtection).toEqual(true);

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.view.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:bigtable", "live"], timeout: 480_000 },
);

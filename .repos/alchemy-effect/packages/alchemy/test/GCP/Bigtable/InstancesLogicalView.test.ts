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
  bigtable.getProjectsInstancesLogicalViews({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("2 seconds"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider(
  "getProjectsInstancesLogicalViews on a missing instance fails with NotFound",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;

      yield* stack.destroy();

      const error = yield* Effect.flip(
        bigtable.getProjectsInstancesLogicalViews({
          name: `projects/${project}/instances/alchemybtmissing/logicalViews/missing`,
        }),
      );
      expect(error._tag).toEqual("NotFound");

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:bigtable", "live"], timeout: 90_000 },
);

test.provider.skipIf(!runLifecycle)(
  "create, update, and delete a bigtable logical view",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const instance = yield* GCP.Bigtable.Instance("Data", {
            displayName: "alchemy-test-bt-logical",
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
            tableId: "users",
            columnFamilies: { cf: { gcRule: { maxNumVersions: 1 } } },
          });
          const view = yield* GCP.Bigtable.InstancesLogicalView("Active", {
            instance: instance.name,
            query: Output.interpolate`SELECT _key FROM \`${table.tableId}\``,
          });
          return { instance, table, view };
        }),
      );

      expect(created.view.name).toContain("/logicalViews/");
      expect(created.view.logicalViewId).toEqual(expect.any(String));
      expect(created.view.instance).toEqual(created.instance.name);
      expect(created.view.query).toContain("users");
      expect(created.view.deletionProtection).toEqual(false);

      const fetched = yield* bigtable.getProjectsInstancesLogicalViews({
        name: created.view.name,
      });
      expect(fetched.name).toEqual(created.view.name);
      expect(fetched.query).toContain("users");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const instance = yield* GCP.Bigtable.Instance("Data", {
            instanceId: created.instance.instanceId,
            displayName: "alchemy-test-bt-logical",
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
            tableId: "users",
            columnFamilies: { cf: { gcRule: { maxNumVersions: 1 } } },
          });
          const view = yield* GCP.Bigtable.InstancesLogicalView("Active", {
            instance: instance.name,
            logicalViewId: created.view.logicalViewId,
            query: Output.interpolate`SELECT _key, cf FROM \`${table.tableId}\``,
            deletionProtection: true,
          });
          return { instance, table, view };
        }),
      );

      expect(updated.view.name).toEqual(created.view.name);
      expect(updated.view.deletionProtection).toEqual(true);

      const refetched = yield* bigtable.getProjectsInstancesLogicalViews({
        name: created.view.name,
      });
      expect(refetched.deletionProtection).toEqual(true);

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.view.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:bigtable", "live"], timeout: 120_000 },
);

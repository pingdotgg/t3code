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

// FileDescriptorSet for `message Row { optional string name = 1; optional int64 count = 2; }`
const PROTO_V1 =
  "Ck4KCXJvdy5wcm90bxIQYWxjaGVteS5iaWd0YWJsZSIvCgNSb3cSEgoEbmFtZRgBIAEoCVIEbmFtZRIUCgVjb3VudBgCIAEoA1IFY291bnQ=";
// Backwards-compatible addition of `optional string extra = 3`.
const PROTO_V2 =
  "CmcKDHJvd192Mi5wcm90bxIQYWxjaGVteS5iaWd0YWJsZSJFCgNSb3cSEgoEbmFtZRgBIAEoCVIEbmFtZRIUCgVjb3VudBgCIAEoA1IFY291bnQSFAoFZXh0cmEYAyABKAlSBWV4dHJh";

const waitUntilGone = (name: string) =>
  bigtable.getProjectsInstancesTablesSchemaBundles({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("2 seconds"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider(
  "getProjectsInstancesTablesSchemaBundles on a missing instance fails with NotFound",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;

      yield* stack.destroy();

      const error = yield* Effect.flip(
        bigtable.getProjectsInstancesTablesSchemaBundles({
          name: `projects/${project}/instances/alchemybtmissing/tables/missing/schemaBundles/missing`,
        }),
      );
      expect(error._tag).toEqual("NotFound");

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:bigtable", "live"], timeout: 90_000 },
);

test.provider.skipIf(!runLifecycle)(
  "create, update, and delete a bigtable schema bundle",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const instance = yield* GCP.Bigtable.Instance("Data", {
            displayName: "alchemy-test-bt-schema",
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
          const bundle = yield* GCP.Bigtable.InstancesTablesSchemaBundle(
            "Rows",
            {
              instance: instance.name,
              table: table.name,
              protoDescriptors: PROTO_V1,
            },
          );
          return { instance, table, bundle };
        }),
      );

      expect(created.bundle.name).toContain("/schemaBundles/");
      expect(created.bundle.schemaBundleId).toEqual(expect.any(String));
      expect(created.bundle.table).toEqual(created.table.name);
      expect(created.bundle.protoDescriptors).toBeDefined();

      const fetched = yield* bigtable.getProjectsInstancesTablesSchemaBundles({
        name: created.bundle.name,
      });
      expect(fetched.name).toEqual(created.bundle.name);
      expect(fetched.protoSchema?.protoDescriptors).toBeDefined();

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const instance = yield* GCP.Bigtable.Instance("Data", {
            instanceId: created.instance.instanceId,
            displayName: "alchemy-test-bt-schema",
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
          const bundle = yield* GCP.Bigtable.InstancesTablesSchemaBundle(
            "Rows",
            {
              instance: instance.name,
              table: table.name,
              schemaBundleId: created.bundle.schemaBundleId,
              protoDescriptors: PROTO_V2,
            },
          );
          return { instance, table, bundle };
        }),
      );

      expect(updated.bundle.name).toEqual(created.bundle.name);
      expect(updated.bundle.protoDescriptors).toBeDefined();

      const refetched = yield* bigtable.getProjectsInstancesTablesSchemaBundles(
        {
          name: created.bundle.name,
        },
      );
      expect(refetched.name).toEqual(created.bundle.name);
      expect(refetched.protoSchema?.protoDescriptors).toBeDefined();

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.bundle.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:bigtable", "live"], timeout: 120_000 },
);

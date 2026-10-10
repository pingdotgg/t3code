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
  bigtable.getProjectsInstancesClusters({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("2 seconds"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider(
  "getProjectsInstancesClusters on a missing cluster fails with NotFound",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;

      yield* stack.destroy();

      const error = yield* Effect.flip(
        bigtable.getProjectsInstancesClusters({
          name: `projects/${project}/instances/alchemy-bt-missing/clusters/missing`,
        }),
      );
      expect(error._tag).toEqual("NotFound");

      const page = yield* bigtable.listProjectsInstancesClusters({
        parent: `projects/${project}/instances/-`,
      });
      expect((page.clusters ?? []).map((item) => item.name)).not.toContain(
        `projects/${project}/instances/alchemy-bt-missing/clusters/missing`,
      );

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:bigtable", "live"], timeout: 90_000 },
);

test.provider.skipIf(!runLifecycle)(
  "create, update, and delete a bigtable cluster",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const instance = yield* GCP.Bigtable.Instance("Data", {
            displayName: "alchemy-test-bt-cluster",
            type: "PRODUCTION",
            clusters: {
              cluster: {
                location: "us-central1-b",
                serveNodes: 1,
                defaultStorageType: "HDD",
              },
            },
          });
          const replica = yield* GCP.Bigtable.Cluster("Replica", {
            instance: instance.name,
            location: "us-central1-c",
            serveNodes: 1,
            defaultStorageType: "HDD",
          });
          return { instance, replica };
        }),
      );

      expect(created.replica.name).toContain("/clusters/");
      expect(created.replica.clusterId).toEqual(expect.any(String));
      expect(created.replica.instance).toEqual(created.instance.name);
      expect(created.replica.location).toEqual("us-central1-c");
      expect(created.replica.serveNodes).toEqual(1);
      expect(created.replica.state).toEqual("READY");

      const fetched = yield* bigtable.getProjectsInstancesClusters({
        name: created.replica.name,
      });
      expect(fetched.name).toEqual(created.replica.name);
      expect(fetched.serveNodes).toEqual(1);

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const instance = yield* GCP.Bigtable.Instance("Data", {
            instanceId: created.instance.instanceId,
            displayName: "alchemy-test-bt-cluster",
            type: "PRODUCTION",
            clusters: {
              cluster: {
                location: "us-central1-b",
                serveNodes: 1,
                defaultStorageType: "HDD",
              },
            },
          });
          const replica = yield* GCP.Bigtable.Cluster("Replica", {
            instance: instance.name,
            clusterId: created.replica.clusterId,
            location: "us-central1-c",
            serveNodes: 2,
            defaultStorageType: "HDD",
          });
          return { instance, replica };
        }),
      );

      expect(updated.replica.name).toEqual(created.replica.name);
      expect(updated.replica.serveNodes).toEqual(2);

      const refetched = yield* bigtable.getProjectsInstancesClusters({
        name: created.replica.name,
      });
      expect(refetched.serveNodes).toEqual(2);

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.replica.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:bigtable", "live"], timeout: 120_000 },
);

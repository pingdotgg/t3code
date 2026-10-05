import { GcpEnvironment } from "@/GCP/Environment";
import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as bigtableadmin from "@distilled.cloud/gcp/bigtableadmin_v2";
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

const lastSegment = (value: string) => {
  const parts = value.replace(/\/+$/, "").split("/");
  return parts[parts.length - 1] || value;
};

const waitUntilGone = (name: string) =>
  bigtableadmin.getProjectsInstancesAppProfiles({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider(
  "getProjectsInstancesAppProfiles on a missing instance fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;

      yield* stack.destroy();

      const error = yield* Effect.flip(
        bigtableadmin.getProjectsInstancesAppProfiles({
          name: `projects/${project}/instances/alchemy-bt-missing/appProfiles/missing`,
        }),
      );
      expect(error._tag).toEqual("NotFound");

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:bigtable", "live"], timeout: 90_000 },
);

test.provider.skipIf(!runLifecycle)(
  "create, update, and delete a bigtable app profile",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;

      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const instance = yield* GCP.Bigtable.Instance("Store", {
            displayName: "alchemy-appprofile-parent",
            labels: { env: "test" },
            clusters: {
              cluster: {
                location: "us-central1-b",
                serveNodes: 1,
                defaultStorageType: "HDD",
              },
            },
          });
          const profile = yield* GCP.Bigtable.AppProfile("Traffic", {
            instance: instance.instanceId,
            description: "alchemy-test-profile",
            multiClusterRouting: {},
          });
          return { instance, profile };
        }),
      );

      expect(created.profile.name).toContain("/appProfiles/");
      expect(created.profile.appProfileId).toEqual(expect.any(String));
      expect(created.profile.instanceId).toEqual(created.instance.instanceId);
      expect(created.profile.project).toEqual(project);
      expect(created.profile.description).toEqual("alchemy-test-profile");
      expect(created.profile.multiClusterRouting).toBeDefined();

      const fetched = yield* bigtableadmin.getProjectsInstancesAppProfiles({
        name: created.profile.name,
      });
      expect(fetched.name).toEqual(created.profile.name);
      expect(fetched.description).toEqual("alchemy-test-profile");
      expect(fetched.multiClusterRoutingUseAny).toBeDefined();

      const clusters = yield* bigtableadmin.listProjectsInstancesClusters({
        parent: created.instance.name,
      });
      const clusterId = lastSegment(
        (clusters.clusters ?? [])[0]?.name ?? "cluster",
      );

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const instance = yield* GCP.Bigtable.Instance("Store", {
            instanceId: created.instance.instanceId,
            displayName: "alchemy-appprofile-parent",
            labels: { env: "test" },
            clusters: {
              [clusterId]: {
                location: "us-central1-b",
                serveNodes: 1,
                defaultStorageType: "HDD",
              },
            },
          });
          const profile = yield* GCP.Bigtable.AppProfile("Traffic", {
            instance: instance.instanceId,
            appProfileId: created.profile.appProfileId,
            description: "alchemy-prod-profile",
            singleClusterRouting: {
              clusterId,
              allowTransactionalWrites: true,
            },
            standardIsolation: { priority: "PRIORITY_HIGH" },
          });
          return { instance, profile };
        }),
      );

      expect(updated.profile.name).toEqual(created.profile.name);
      expect(updated.profile.description).toEqual("alchemy-prod-profile");
      expect(updated.profile.singleClusterRouting?.clusterId).toEqual(
        clusterId,
      );
      expect(
        updated.profile.singleClusterRouting?.allowTransactionalWrites,
      ).toEqual(true);
      expect(updated.profile.standardIsolation?.priority).toEqual(
        "PRIORITY_HIGH",
      );

      const refetched = yield* bigtableadmin.getProjectsInstancesAppProfiles({
        name: created.profile.name,
      });
      expect(refetched.description).toEqual("alchemy-prod-profile");
      expect(refetched.singleClusterRouting?.clusterId).toEqual(clusterId);
      expect(refetched.standardIsolation?.priority).toEqual("PRIORITY_HIGH");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.profile.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:bigtable", "live"], timeout: 120_000 },
);

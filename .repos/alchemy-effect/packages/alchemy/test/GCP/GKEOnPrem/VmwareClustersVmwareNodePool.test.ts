import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as gkeonprem from "@distilled.cloud/gcp/gkeonprem_v1";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import {
  missingMembership,
  missingVmwareCluster,
  currentProject,
  vmwareAdminMembership,
  runVmwareLifecycle,
  vmwareControlPlane,
  vmwareLoadBalancer,
  vmwareNetwork,
} from "./common.ts";

const { test } = Test.make({ providers: GCP.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const waitUntilGone = (name: string) =>
  gkeonprem.getProjectsLocationsVmwareClustersVmwareNodePools({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("2 seconds"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider(
  "getProjectsLocationsVmwareClustersVmwareNodePools on a missing pool fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      const project = yield* currentProject;

      yield* stack.destroy();

      const error = yield* Effect.flip(
        gkeonprem.getProjectsLocationsVmwareClustersVmwareNodePools({
          name: `${missingVmwareCluster(project)}/vmwareNodePools/alchemy-missing-pool`,
        }),
      );
      expect(error._tag).toEqual("NotFound");

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:gkeonprem", "live"], timeout: 90_000 },
);

test.provider.skipIf(runVmwareLifecycle)(
  "create under a missing cluster is rejected with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      const project = yield* currentProject;

      yield* stack.destroy();

      const error = yield* Effect.flip(
        stack.deploy(
          Effect.gen(function* () {
            return yield* GCP.GKEOnPrem.VmwareClustersVmwareNodePool(
              "Workers",
              {
                vmwareCluster: missingVmwareCluster(project),
                config: {
                  imageType: "ubuntu_containerd",
                  replicas: "3",
                  cpus: "4",
                  memoryMb: "8192",
                },
                displayName: "alchemy-test-vmnp",
                labels: { env: "test" },
              },
            );
          }),
        ),
      );
      expect(error._tag).toEqual("NotFound");

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:gkeonprem", "live"], timeout: 90_000 },
);

test.provider.skipIf(!runVmwareLifecycle)(
  "create, update, and delete a vmware node pool",
  (stack) =>
    Effect.gen(function* () {
      const project = yield* currentProject;

      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const cluster = yield* GCP.GKEOnPrem.VmwareCluster("Workload", {
            adminClusterMembership:
              vmwareAdminMembership ?? missingMembership(project),
            onPremVersion: "1.28.0-gke.1",
            controlPlaneNode: vmwareControlPlane,
            networkConfig: vmwareNetwork,
            loadBalancer: vmwareLoadBalancer,
            description: "node pool parent",
          });
          const pool = yield* GCP.GKEOnPrem.VmwareClustersVmwareNodePool(
            "Workers",
            {
              vmwareCluster: cluster.name,
              config: {
                imageType: "ubuntu_containerd",
                replicas: "3",
                cpus: "4",
                memoryMb: "8192",
              },
              displayName: "alchemy-test-vmnp",
              labels: { env: "test" },
            },
          );
          return { cluster, pool };
        }),
      );

      expect(created.pool.name).toContain("/vmwareNodePools/");
      expect(created.pool.vmwareCluster).toEqual(created.cluster.name);
      expect(created.pool.displayName).toEqual("alchemy-test-vmnp");

      const fetched =
        yield* gkeonprem.getProjectsLocationsVmwareClustersVmwareNodePools({
          name: created.pool.name,
        });
      expect(fetched.name).toEqual(created.pool.name);
      expect(fetched.displayName).toContain("alchemy-id=");
      expect(fetched.annotations?.["alchemy-id"]).toBeDefined();

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const cluster = yield* GCP.GKEOnPrem.VmwareCluster("Workload", {
            vmwareClusterId: created.cluster.vmwareClusterId,
            location: created.cluster.location,
            adminClusterMembership:
              created.cluster.adminClusterMembership ??
              vmwareAdminMembership ??
              missingMembership(project),
            onPremVersion: created.cluster.onPremVersion ?? "1.28.0-gke.1",
            controlPlaneNode:
              created.cluster.controlPlaneNode ?? vmwareControlPlane,
            networkConfig: created.cluster.networkConfig ?? vmwareNetwork,
            loadBalancer: created.cluster.loadBalancer ?? vmwareLoadBalancer,
            description: "node pool parent",
          });
          const pool = yield* GCP.GKEOnPrem.VmwareClustersVmwareNodePool(
            "Workers",
            {
              vmwareNodePoolId: created.pool.vmwareNodePoolId,
              vmwareCluster: cluster.name,
              config: {
                imageType: "ubuntu_containerd",
                replicas: "5",
                cpus: "4",
                memoryMb: "8192",
              },
              displayName: "alchemy-test-vmnp-v2",
            },
          );
          return { cluster, pool };
        }),
      );

      expect(updated.pool.displayName).toEqual("alchemy-test-vmnp-v2");
      expect(updated.pool.vmwareNodePoolId).toEqual(
        created.pool.vmwareNodePoolId,
      );

      yield* stack.destroy();
      yield* waitUntilGone(created.pool.name);
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:gkeonprem", "live"],
    timeout: 120_000,
  },
);

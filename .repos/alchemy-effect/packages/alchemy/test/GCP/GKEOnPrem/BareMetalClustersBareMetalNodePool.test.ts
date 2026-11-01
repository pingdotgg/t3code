import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as gkeonprem from "@distilled.cloud/gcp/gkeonprem_v1";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import {
  bareMetalControlPlane,
  bareMetalLoadBalancer,
  bareMetalNetwork,
  bareMetalStorage,
  missingBareMetalCluster,
  missingMembership,
  currentProject,
  bareMetalAdminMembership,
  runBareMetalLifecycle,
} from "./common.ts";

const { test } = Test.make({ providers: GCP.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const waitUntilGone = (name: string) =>
  gkeonprem
    .getProjectsLocationsBareMetalClustersBareMetalNodePools({ name })
    .pipe(
      Effect.as("found" as const),
      Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
      Effect.repeat({
        schedule: Schedule.spaced("2 seconds"),
        until: (status) => status === "gone",
        times: 10,
      }),
    );

test.provider(
  "getProjectsLocationsBareMetalClustersBareMetalNodePools on a missing pool fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      const project = yield* currentProject;

      yield* stack.destroy();

      const error = yield* Effect.flip(
        gkeonprem.getProjectsLocationsBareMetalClustersBareMetalNodePools({
          name: `${missingBareMetalCluster(project)}/bareMetalNodePools/alchemy-missing-pool`,
        }),
      );
      expect(error._tag).toEqual("NotFound");

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:gkeonprem", "live"], timeout: 90_000 },
);

test.provider.skipIf(runBareMetalLifecycle)(
  "create under a missing cluster is rejected with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      const project = yield* currentProject;

      yield* stack.destroy();

      const error = yield* Effect.flip(
        stack.deploy(
          Effect.gen(function* () {
            return yield* GCP.GKEOnPrem.BareMetalClustersBareMetalNodePool(
              "Workers",
              {
                bareMetalCluster: missingBareMetalCluster(project),
                nodePoolConfig: {
                  nodeConfigs: [{ nodeIp: "10.200.0.11" }],
                },
                displayName: "alchemy-test-bmnp",
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

test.provider.skipIf(!runBareMetalLifecycle)(
  "create, update, and delete a bare metal node pool",
  (stack) =>
    Effect.gen(function* () {
      const project = yield* currentProject;

      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const cluster = yield* GCP.GKEOnPrem.BareMetalCluster("Workload", {
            adminClusterMembership:
              bareMetalAdminMembership ?? missingMembership(project),
            bareMetalVersion: "1.28.0-gke.1",
            controlPlane: bareMetalControlPlane,
            storage: bareMetalStorage,
            networkConfig: bareMetalNetwork,
            loadBalancer: bareMetalLoadBalancer,
            description: "node pool parent",
          });
          const pool = yield* GCP.GKEOnPrem.BareMetalClustersBareMetalNodePool(
            "Workers",
            {
              bareMetalCluster: cluster.name,
              nodePoolConfig: {
                nodeConfigs: [{ nodeIp: "10.200.0.11" }],
              },
              displayName: "alchemy-test-bmnp",
              labels: { env: "test" },
            },
          );
          return { cluster, pool };
        }),
      );

      expect(created.pool.name).toContain("/bareMetalNodePools/");
      expect(created.pool.bareMetalCluster).toEqual(created.cluster.name);
      expect(created.pool.displayName).toEqual("alchemy-test-bmnp");

      const fetched =
        yield* gkeonprem.getProjectsLocationsBareMetalClustersBareMetalNodePools(
          { name: created.pool.name },
        );
      expect(fetched.name).toEqual(created.pool.name);
      expect(fetched.displayName).toContain("alchemy-id=");
      expect(fetched.annotations?.["alchemy-id"]).toBeDefined();

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const cluster = yield* GCP.GKEOnPrem.BareMetalCluster("Workload", {
            bareMetalClusterId: created.cluster.bareMetalClusterId,
            location: created.cluster.location,
            adminClusterMembership:
              created.cluster.adminClusterMembership ??
              bareMetalAdminMembership ??
              missingMembership(project),
            bareMetalVersion:
              created.cluster.bareMetalVersion ?? "1.28.0-gke.1",
            controlPlane: created.cluster.controlPlane ?? bareMetalControlPlane,
            storage: created.cluster.storage ?? bareMetalStorage,
            networkConfig: created.cluster.networkConfig ?? bareMetalNetwork,
            loadBalancer: created.cluster.loadBalancer ?? bareMetalLoadBalancer,
            description: "node pool parent",
          });
          const pool = yield* GCP.GKEOnPrem.BareMetalClustersBareMetalNodePool(
            "Workers",
            {
              bareMetalNodePoolId: created.pool.bareMetalNodePoolId,
              bareMetalCluster: cluster.name,
              nodePoolConfig: {
                nodeConfigs: [
                  { nodeIp: "10.200.0.11" },
                  { nodeIp: "10.200.0.12" },
                ],
              },
              displayName: "alchemy-test-bmnp-v2",
            },
          );
          return { cluster, pool };
        }),
      );

      expect(updated.pool.displayName).toEqual("alchemy-test-bmnp-v2");
      expect(updated.pool.bareMetalNodePoolId).toEqual(
        created.pool.bareMetalNodePoolId,
      );

      yield* stack.destroy();
      yield* waitUntilGone(created.pool.name);
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:gkeonprem", "live"],
    timeout: 120_000,
  },
);

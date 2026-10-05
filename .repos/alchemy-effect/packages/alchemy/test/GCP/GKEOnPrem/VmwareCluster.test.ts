import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as gkeonprem from "@distilled.cloud/gcp/gkeonprem_v1";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import {
  missingMembership,
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
  gkeonprem.getProjectsLocationsVmwareClusters({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("2 seconds"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider(
  "getProjectsLocationsVmwareClusters on a missing cluster fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      const project = yield* currentProject;

      yield* stack.destroy();

      const error = yield* Effect.flip(
        gkeonprem.getProjectsLocationsVmwareClusters({
          name: `projects/${project}/locations/us-central1/vmwareClusters/alchemy-missing-vmc`,
        }),
      );
      expect(error._tag).toEqual("NotFound");

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:gkeonprem", "live"], timeout: 90_000 },
);

test.provider.skipIf(runVmwareLifecycle)(
  "create without an admin cluster fails with AdminClusterUnreachable",
  (stack) =>
    Effect.gen(function* () {
      const project = yield* currentProject;

      yield* stack.destroy();

      const error = yield* Effect.flip(
        stack.deploy(
          Effect.gen(function* () {
            return yield* GCP.GKEOnPrem.VmwareCluster("Workload", {
              adminClusterMembership: missingMembership(project),
              onPremVersion: "1.28.0-gke.1",
              controlPlaneNode: vmwareControlPlane,
              networkConfig: vmwareNetwork,
              loadBalancer: vmwareLoadBalancer,
              description: "alchemy-test-vmc",
              labels: { env: "test" },
            });
          }),
        ),
      );
      expect(error._tag).toEqual("AdminClusterUnreachable");

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:gkeonprem", "live"], timeout: 90_000 },
);

test.provider.skipIf(!runVmwareLifecycle)(
  "create, update, and delete a vmware cluster",
  (stack) =>
    Effect.gen(function* () {
      const project = yield* currentProject;

      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.GKEOnPrem.VmwareCluster("Workload", {
            adminClusterMembership:
              vmwareAdminMembership ?? missingMembership(project),
            onPremVersion: "1.28.0-gke.1",
            controlPlaneNode: vmwareControlPlane,
            networkConfig: vmwareNetwork,
            loadBalancer: vmwareLoadBalancer,
            description: "alchemy-test-vmc",
            labels: { env: "test" },
          });
        }),
      );

      expect(created.name).toContain("/vmwareClusters/");
      expect(created.description).toEqual("alchemy-test-vmc");
      expect(created.labels.env).toEqual("test");

      const fetched = yield* gkeonprem.getProjectsLocationsVmwareClusters({
        name: created.name,
      });
      expect(fetched.name).toEqual(created.name);
      expect(fetched.description).toContain("alchemy-id=");
      expect(fetched.description).toContain("alchemy-test-vmc");
      expect(fetched.annotations?.["alchemy-id"]).toBeDefined();

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.GKEOnPrem.VmwareCluster("Workload", {
            vmwareClusterId: created.vmwareClusterId,
            location: created.location,
            adminClusterMembership:
              created.adminClusterMembership ??
              vmwareAdminMembership ??
              missingMembership(project),
            onPremVersion: created.onPremVersion ?? "1.28.0-gke.1",
            controlPlaneNode: created.controlPlaneNode ?? vmwareControlPlane,
            networkConfig: created.networkConfig ?? vmwareNetwork,
            loadBalancer: created.loadBalancer ?? vmwareLoadBalancer,
            description: "alchemy-test-vmc-v2",
            labels: { env: "test", team: "platform" },
          });
        }),
      );

      expect(updated.description).toEqual("alchemy-test-vmc-v2");
      expect(updated.labels.team).toEqual("platform");
      expect(updated.vmwareClusterId).toEqual(created.vmwareClusterId);

      yield* stack.destroy();
      yield* waitUntilGone(created.name);
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:gkeonprem", "live"],
    timeout: 120_000,
  },
);

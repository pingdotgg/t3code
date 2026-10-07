import * as GCP from "@/GCP";
import { findClusterAdapter } from "@/Kubernetes/ClusterAdapter.ts";
import * as Test from "@/Test/Alchemy";
import * as container from "@distilled.cloud/gcp/container_v1";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import { GcpEnvironment } from "@/GCP/Environment";
import { CAPACITY_ZONE, withGkeClusterSlot } from "../zones.ts";

const { test } = Test.make({ providers: GCP.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

// GKE cluster create and delete each take 5-10 minutes.
const runLifecycle = !!process.env.GCP_TEST_SLOW && !process.env.FAST;

const waitUntilGone = (name: string) =>
  container.getProjectsLocationsClusters({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("3 seconds"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider(
  "lists clusters and treats a missing cluster as NotFound",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { project } = yield* GcpEnvironment.current;
      const page = yield* container.listProjectsLocationsClusters({
        parent: `projects/${project}/locations/-`,
      });
      expect(
        (page.clusters ?? []).map((cluster) => cluster.name),
      ).not.toContain("alchemy-missing-cluster");

      const missing = yield* container
        .getProjectsLocationsClusters({
          name: `projects/${project}/locations/${CAPACITY_ZONE}/clusters/alchemy-missing-cluster`,
        })
        .pipe(
          Effect.as("found" as const),
          Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
        );
      expect(missing).toEqual("gone");

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:container", "live"], timeout: 90_000 },
);

test.provider(
  "registers the gcp-gke kubernetes adapter",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const adapter = yield* findClusterAdapter("gcp-gke");
      expect(adapter.kind).toEqual("Kubernetes.ClusterAdapter");
      expect(adapter.identity).toBeDefined();
      expect(adapter.registry).toBeDefined();
      expect(adapter.bootstrap).toBeDefined();
      expect(adapter.loadBalancerDefaults).toBeDefined();

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:container", "live"], timeout: 90_000 },
);

test.provider.skipIf(!runLifecycle)(
  "create, update, and delete a cluster",
  (stack) =>
    withGkeClusterSlot(
      Effect.gen(function* () {
        const { project } = yield* GcpEnvironment.current;
        yield* stack.destroy();

        const created = yield* stack.deploy(
          Effect.gen(function* () {
            return yield* GCP.Container.Cluster("App", {
              location: CAPACITY_ZONE,
              machineType: "e2-medium",
              initialNodeCount: 1,
              diskSizeGb: 20,
              spot: true,
              description: "alchemy-test-cluster",
              labels: { env: "test" },
            });
          }),
        );

        expect(created.name).toContain("/clusters/");
        expect(created.clusterId).toEqual(expect.any(String));
        expect(created.location).toEqual(CAPACITY_ZONE);
        expect(created.description).toEqual("alchemy-test-cluster");
        expect(created.labels).toMatchObject({ env: "test" });
        expect(created.status).toEqual("RUNNING");
        expect(created.autopilot).toEqual(false);
        expect(created.endpoint).toEqual(expect.stringMatching(/^https:\/\//));
        expect(created.certificateAuthorityData).toEqual(expect.any(String));
        expect(created.connection.auth.kind).toEqual("gcp-gke");
        if (created.connection.auth.kind === "gcp-gke") {
          expect(created.connection.auth.clusterId).toEqual(created.clusterId);
        }
        expect(created.kubernetesObjects).toEqual([]);
        expect(created.workloadPool).toEqual(`${project}.svc.id.goog`);

        const fetched = yield* container.getProjectsLocationsClusters({
          name: created.name,
        });
        expect(fetched.name).toEqual(created.clusterId);
        expect(fetched.resourceLabels?.env).toEqual("test");
        expect(fetched.description).toEqual("alchemy-test-cluster");
        expect(fetched.status).toEqual("RUNNING");

        const updated = yield* stack.deploy(
          Effect.gen(function* () {
            return yield* GCP.Container.Cluster("App", {
              clusterId: created.clusterId,
              location: CAPACITY_ZONE,
              machineType: "e2-medium",
              initialNodeCount: 1,
              diskSizeGb: 20,
              spot: true,
              description: "alchemy-test-cluster",
              loggingService: "none",
              labels: { env: "prod", role: "k8s" },
            });
          }),
        );

        expect(updated.name).toEqual(created.name);
        expect(updated.clusterUid).toEqual(created.clusterUid);
        expect(updated.labels).toMatchObject({ env: "prod", role: "k8s" });
        expect(updated.loggingService).toEqual("none");

        const refetched = yield* container.getProjectsLocationsClusters({
          name: created.name,
        });
        expect(refetched.resourceLabels?.env).toEqual("prod");
        expect(refetched.resourceLabels?.role).toEqual("k8s");
        expect(refetched.loggingService).toEqual("none");
        // An unspecified monitoring service keeps its observed value.
        expect(refetched.monitoringService).toEqual(created.monitoringService);

        yield* stack.destroy();

        const gone = yield* waitUntilGone(created.name);
        expect(gone).toEqual("gone");
      }),
    ).pipe(logLevel),
  // Create ~6 min, logging update ~5 min, delete ~5 min.
  {
    tags: ["provider:gcp", "provider:gcp:container", "live"],
    timeout: 1_800_000,
    retry: 0,
  },
);

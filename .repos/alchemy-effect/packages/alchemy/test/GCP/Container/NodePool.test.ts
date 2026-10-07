import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as container from "@distilled.cloud/gcp/container_v1";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import { GcpEnvironment } from "@/GCP/Environment";
import { waitForOperation } from "@/GCP/Operation";
import { CAPACITY_ZONE, withGkeClusterSlot } from "../zones.ts";

const { test } = Test.make({ providers: GCP.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

// GKE cluster create and delete each take 5-10 minutes.
const runLifecycle = !!process.env.GCP_TEST_SLOW && !process.env.FAST;

// Pools stay empty: every GKE node holds an external IP and the project
// allows only 8 IN_USE_ADDRESSES per region, shared by every capacity test.
const POOL_NODE_COUNT = 0;

const HOST_CLUSTER_ID = "alch-np-host";
const HOST_LOCATION = CAPACITY_ZONE;

const waitUntilGone = (name: string) =>
  container.getProjectsLocationsClustersNodePools({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("3 seconds"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

// GKE cluster create/delete takes 5–10 minutes.
const waitClusterOp = (project: string, operation: container.Operation) => {
  const raw = operation.name ?? "";
  const fromLink = operation.selfLink ?? "";
  const name = raw.includes("/operations/")
    ? raw.slice(Math.max(0, raw.indexOf("projects/")))
    : fromLink.includes("/operations/")
      ? fromLink.slice(Math.max(0, fromLink.indexOf("projects/")))
      : `projects/${project}/locations/${HOST_LOCATION}/operations/${raw}`;
  return waitForOperation(
    { ...operation, name },
    (operationName) =>
      container.getProjectsLocationsOperations({ name: operationName }),
    { budget: "20 minutes", interval: "10 seconds" },
  );
};

test.provider(
  "lists clusters and treats a missing node pool as NotFound",
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
        .getProjectsLocationsClustersNodePools({
          name: `projects/${project}/locations/${HOST_LOCATION}/clusters/alchemy-missing-cluster/nodePools/alchemy-missing-pool`,
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

/**
 * A throwaway host cluster without Workload Identity (the node pool must
 * not request GKE_METADATA on it). Owned by this test: a leftover from an
 * interrupted run is reused if RUNNING, replaced otherwise, and always
 * deleted when the test ends.
 */
const withHostCluster = <A, E, R>(
  project: string,
  body: (host: {
    clusterId: string;
    location: string;
  }) => Effect.Effect<A, E, R>,
) => {
  const clusterName = `projects/${project}/locations/${HOST_LOCATION}/clusters/${HOST_CLUSTER_ID}`;
  const deleteHost = container
    .deleteProjectsLocationsClusters({ name: clusterName })
    .pipe(
      Effect.flatMap((operation) => waitClusterOp(project, operation)),
      Effect.catchTag("NotFound", () => Effect.void),
    );
  const ensureHost = Effect.gen(function* () {
    const existing = yield* container
      .getProjectsLocationsClusters({ name: clusterName })
      .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));
    if (existing?.status === "RUNNING") return;
    if (existing !== undefined) yield* deleteHost;
    const created = yield* container.createProjectsLocationsClusters({
      parent: `projects/${project}/locations/${HOST_LOCATION}`,
      body: {
        cluster: {
          name: HOST_CLUSTER_ID,
          ipAllocationPolicy: { useIpAliases: true },
          nodePools: [
            {
              name: "default-pool",
              initialNodeCount: 1,
              config: {
                machineType: "e2-medium",
                diskSizeGb: 20,
                diskType: "pd-standard",
                spot: true,
              },
            },
          ],
        },
      },
    });
    yield* waitClusterOp(project, created);
  });
  return ensureHost.pipe(
    Effect.andThen(
      body({ clusterId: HOST_CLUSTER_ID, location: HOST_LOCATION }),
    ),
    Effect.ensuring(Effect.ignore(deleteHost)),
  );
};

test.provider.skipIf(!runLifecycle)(
  "create, update, and delete a node pool",
  (stack) =>
    withGkeClusterSlot(
      Effect.gen(function* () {
        yield* stack.destroy();
        const { project } = yield* GcpEnvironment.current;
        yield* withHostCluster(
          project,
          ({ clusterId: hostId, location: hostLocation }) =>
            Effect.gen(function* () {
              const created = yield* stack.deploy(
                Effect.gen(function* () {
                  return yield* GCP.Container.NodePool("Workers", {
                    cluster: hostId,
                    location: hostLocation,
                    nodeCount: POOL_NODE_COUNT,
                    machineType: "e2-medium",
                    diskSizeGb: 20,
                    spot: true,
                    management: { autoRepair: false, autoUpgrade: true },
                    labels: { env: "test" },
                  });
                }),
              );

              expect(created.name).toContain("/nodePools/");
              expect(created.nodePoolId).toEqual(expect.any(String));
              expect(created.clusterId).toEqual(hostId);
              expect(created.location).toEqual(hostLocation);
              expect(created.labels).toMatchObject({ env: "test" });
              expect(created.spot).toEqual(true);
              expect(created.nodeCount).toEqual(POOL_NODE_COUNT);
              expect(["RUNNING", "RUNNING_WITH_ERROR"]).toContain(
                created.status,
              );

              const fetched =
                yield* container.getProjectsLocationsClustersNodePools({
                  name: created.name,
                });
              expect(fetched.name).toEqual(created.nodePoolId);
              expect(fetched.config?.resourceLabels?.env).toEqual("test");
              expect(fetched.config?.spot).toEqual(true);

              const updated = yield* stack.deploy(
                Effect.gen(function* () {
                  return yield* GCP.Container.NodePool("Workers", {
                    cluster: hostId,
                    location: hostLocation,
                    nodePoolId: created.nodePoolId,
                    nodeCount: POOL_NODE_COUNT,
                    machineType: "e2-medium",
                    diskSizeGb: 20,
                    spot: true,
                    management: { autoRepair: true, autoUpgrade: true },
                    labels: { env: "prod", role: "workers" },
                  });
                }),
              );

              expect(updated.name).toEqual(created.name);
              expect(updated.labels).toMatchObject({
                env: "prod",
                role: "workers",
              });
              expect(updated.management?.autoRepair).toEqual(true);

              const refetched =
                yield* container.getProjectsLocationsClustersNodePools({
                  name: created.name,
                });
              expect(refetched.config?.resourceLabels?.env).toEqual("prod");
              expect(refetched.config?.resourceLabels?.role).toEqual("workers");
              expect(refetched.management?.autoRepair).toEqual(true);

              yield* stack.destroy();

              const gone = yield* waitUntilGone(created.name);
              expect(gone).toEqual("gone");
            }),
        );
      }),
    ).pipe(logLevel),
  // Host create ~6 min, pool create/update ~5 min, host delete ~5 min.
  {
    tags: ["provider:gcp", "provider:gcp:container", "live"],
    timeout: 1_800_000,
    retry: 0,
  },
);

import * as GCP from "@alchemy.run/gcp";
import { GcpEnvironment } from "@alchemy.run/gcp/Environment";
import { waitForOperation } from "@alchemy.run/gcp/Operation";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as container from "@distilled.cloud/gcp/container_v1";
import { adopt } from "alchemy/AdoptPolicy";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import { CAPACITY_ZONE, withGkeClusterSlot } from "../zones.ts";

const { test } = Test.make({ providers: GCP.providers() });

const logLevel = Effect.provideService(MinimumLogLevel, process.env.DEBUG ? "Debug" : "Info");

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
    (operationName) => container.getProjectsLocationsOperations({ name: operationName }),
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
      expect((page.clusters ?? []).map((cluster) => cluster.name)).not.toContain(
        "alchemy-missing-cluster",
      );

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
  body: (host: { clusterId: string; location: string }) => Effect.Effect<A, E, R>,
) => {
  const clusterName = `projects/${project}/locations/${HOST_LOCATION}/clusters/${HOST_CLUSTER_ID}`;
  const deleteHost = container.deleteProjectsLocationsClusters({ name: clusterName }).pipe(
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
    Effect.andThen(body({ clusterId: HOST_CLUSTER_ID, location: HOST_LOCATION })),
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
        yield* withHostCluster(project, ({ clusterId: hostId, location: hostLocation }) =>
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
                  metadata: { "disable-legacy-endpoints": "true" },
                  // The host has no Workload Identity, so GKE_METADATA is
                  // rejected; set the alternative explicitly.
                  workloadMetadataConfig: { mode: "GCE_METADATA" },
                  shieldedInstanceConfig: {
                    enableIntegrityMonitoring: true,
                    enableSecureBoot: true,
                  },
                  advancedMachineFeatures: { enableNestedVirtualization: false },
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
            expect(created.metadata["disable-legacy-endpoints"]).toEqual("true");
            expect(created.workloadMetadataConfig?.mode).toEqual("GCE_METADATA");
            expect(created.shieldedInstanceConfig?.enableSecureBoot).toEqual(true);
            expect(["RUNNING", "RUNNING_WITH_ERROR"]).toContain(created.status);

            const fetched = yield* container.getProjectsLocationsClustersNodePools({
              name: created.name,
            });
            expect(fetched.name).toEqual(created.nodePoolId);
            expect(fetched.config?.resourceLabels?.env).toEqual("test");
            expect(fetched.config?.spot).toEqual(true);
            expect(fetched.config?.metadata?.["disable-legacy-endpoints"]).toEqual("true");
            expect(fetched.config?.workloadMetadataConfig?.mode).toEqual("GCE_METADATA");
            expect(fetched.config?.shieldedInstanceConfig?.enableSecureBoot).toEqual(true);

            const workersProps: GCP.Container.NodePoolProps = {
              cluster: hostId,
              location: hostLocation,
              nodePoolId: created.nodePoolId,
              nodeCount: POOL_NODE_COUNT,
              machineType: "e2-medium",
              diskSizeGb: 20,
              spot: true,
              management: { autoRepair: true, autoUpgrade: true },
              labels: { env: "prod", role: "workers" },
              metadata: { "disable-legacy-endpoints": "true" },
              // The host has no Workload Identity, so GKE_METADATA is
              // rejected; set the alternative explicitly.
              workloadMetadataConfig: { mode: "GCE_METADATA" },
              shieldedInstanceConfig: {
                enableIntegrityMonitoring: true,
                enableSecureBoot: true,
              },
              advancedMachineFeatures: { enableNestedVirtualization: false },
            };
            const workers = (props: Partial<GCP.Container.NodePoolProps> = {}) =>
              GCP.Container.NodePool("Workers", { ...workersProps, ...props });

            const updated = yield* stack.deploy(workers());

            expect(updated.name).toEqual(created.name);
            expect(updated.labels).toMatchObject({
              env: "prod",
              role: "workers",
            });
            expect(updated.management?.autoRepair).toEqual(true);

            const refetched = yield* container.getProjectsLocationsClustersNodePools({
              name: created.name,
            });
            expect(refetched.config?.resourceLabels?.env).toEqual("prod");
            expect(refetched.config?.resourceLabels?.role).toEqual("workers");
            expect(refetched.management?.autoRepair).toEqual(true);

            // VM settings are fixed when the pool's nodes are created.
            expect(
              (yield* stack.plan(
                workers({ advancedMachineFeatures: { enableNestedVirtualization: true } }),
              )).resources.Workers,
            ).toMatchObject({ action: "replace", deleteFirst: true });
            expect(
              (yield* stack.plan(workers({ metadata: { "disable-legacy-endpoints": "false" } })))
                .resources.Workers,
            ).toMatchObject({ action: "replace", deleteFirst: true });

            yield* stack.destroy();

            const gone = yield* waitUntilGone(created.name);
            expect(gone).toEqual("gone");

            // Adopting a pool created outside Alchemy: GKE injects metadata and
            // omits false booleans, which must not count as changes.
            const foreignId = "alch-np-foreign";
            const foreignName = `projects/${project}/locations/${hostLocation}/clusters/${hostId}/nodePools/${foreignId}`;
            const existingForeign = yield* container
              .getProjectsLocationsClustersNodePools({ name: foreignName })
              .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));
            if (existingForeign === undefined) {
              const op = yield* container.createProjectsLocationsClustersNodePools({
                parent: `projects/${project}/locations/${hostLocation}/clusters/${hostId}`,
                body: {
                  nodePool: {
                    name: foreignId,
                    initialNodeCount: POOL_NODE_COUNT,
                    config: { machineType: "e2-medium", diskSizeGb: 20, spot: true },
                  },
                },
              });
              yield* waitClusterOp(project, op);
            }
            const adopted = (props: Partial<GCP.Container.NodePoolProps>) =>
              GCP.Container.NodePool("Adopted", {
                cluster: hostId,
                location: hostLocation,
                nodePoolId: foreignId,
                nodeCount: POOL_NODE_COUNT,
                machineType: "e2-medium",
                diskSizeGb: 20,
                spot: true,
                ...props,
              }).pipe(adopt(true));
            const actionOf = (props: Partial<GCP.Container.NodePoolProps>) =>
              stack.plan(adopted(props)).pipe(Effect.map((plan) => plan.resources.Adopted));

            expect((yield* actionOf({ metadata: {} })).action).not.toBe("replace");
            expect(
              (yield* actionOf({
                metadata: {},
                shieldedInstanceConfig: { enableSecureBoot: false },
              })).action,
            ).not.toBe("replace");
            expect(
              (yield* actionOf({ metadata: { "disable-legacy-endpoints": "true" } })).action,
            ).not.toBe("replace");
            expect(yield* actionOf({ metadata: { owner: "team-a" } })).toMatchObject({
              action: "replace",
              deleteFirst: true,
            });

            const adoptedPool = yield* stack.deploy(
              adopted({ metadata: { "disable-legacy-endpoints": "true" } }),
            );
            expect(adoptedPool.nodePoolId).toEqual(foreignId);
            yield* stack.destroy();
            expect(yield* waitUntilGone(foreignName)).toEqual("gone");
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

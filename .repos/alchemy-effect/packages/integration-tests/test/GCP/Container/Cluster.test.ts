import * as GCP from "@alchemy.run/gcp";
import { GcpEnvironment } from "@alchemy.run/gcp/Environment";
import { findClusterAdapter } from "@alchemy.run/kubernetes/ClusterAdapter";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as container from "@distilled.cloud/gcp/container_v1";
import * as Output from "alchemy/Output";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Result from "effect/Result";
import * as Schedule from "effect/Schedule";
import { CAPACITY_REGION, CAPACITY_ZONE, CAPACITY_ZONE_2, withGkeClusterSlot } from "../zones.ts";

const { test } = Test.make({ providers: GCP.providers() });

const logLevel = Effect.provideService(MinimumLogLevel, process.env.DEBUG ? "Debug" : "Info");

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
      expect((page.clusters ?? []).map((cluster) => cluster.name)).not.toContain(
        "alchemy-missing-cluster",
      );

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
              ipAllocationPolicy: { useIpAliases: true },
              enableShieldedNodes: true,
              addonsConfig: { horizontalPodAutoscaling: { disabled: false } },
              costManagementConfig: { enabled: true },
              loggingConfig: {
                componentConfig: { enableComponents: ["SYSTEM_COMPONENTS"] },
              },
              monitoringConfig: {
                componentConfig: { enableComponents: ["SYSTEM_COMPONENTS"] },
                managedPrometheusConfig: { enabled: true },
              },
              removeDefaultNodePool: true,
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
        expect(created.ipAllocationPolicy?.useIpAliases).toEqual(true);
        expect(created.enableShieldedNodes).toEqual(true);
        // GKE omits proto3 defaults, so an enabled addon reports no `disabled`.
        expect(created.addonsConfig?.horizontalPodAutoscaling?.disabled ?? false).toEqual(false);
        expect(created.costManagementConfig?.enabled).toEqual(true);
        expect(created.loggingConfig?.componentConfig?.enableComponents).toContain(
          "SYSTEM_COMPONENTS",
        );
        expect(created.monitoringConfig?.componentConfig?.enableComponents).toContain(
          "SYSTEM_COMPONENTS",
        );
        expect(created.monitoringConfig?.managedPrometheusConfig?.enabled).toEqual(true);

        const fetched = yield* container.getProjectsLocationsClusters({
          name: created.name,
        });
        expect(fetched.name).toEqual(created.clusterId);
        expect(fetched.resourceLabels?.env).toEqual("test");
        expect(fetched.description).toEqual("alchemy-test-cluster");
        expect(fetched.status).toEqual("RUNNING");
        expect(fetched.shieldedNodes?.enabled).toEqual(true);
        expect(fetched.costManagementConfig?.enabled).toEqual(true);

        const defaultPool = yield* container
          .getProjectsLocationsClustersNodePools({
            name: `${created.name}/nodePools/default-pool`,
          })
          .pipe(
            Effect.as("found" as const),
            Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
          );
        expect(defaultPool).toEqual("gone");

        const prodProps: GCP.Container.ClusterProps = {
          clusterId: created.clusterId,
          location: CAPACITY_ZONE,
          machineType: "e2-medium",
          initialNodeCount: 1,
          diskSizeGb: 20,
          spot: true,
          description: "alchemy-test-cluster",
          // `loggingConfig` is dropped here — it conflicts with "none".
          loggingService: "none",
          monitoringConfig: {
            componentConfig: { enableComponents: ["SYSTEM_COMPONENTS"] },
            managedPrometheusConfig: { enabled: true },
          },
          labels: { env: "prod", role: "k8s" },
          ipAllocationPolicy: { useIpAliases: true },
          enableShieldedNodes: true,
          addonsConfig: { horizontalPodAutoscaling: { disabled: false } },
          costManagementConfig: { enabled: true },
          removeDefaultNodePool: true,
        };
        const prod = (props: Partial<GCP.Container.ClusterProps> = {}) =>
          GCP.Container.Cluster("App", { ...prodProps, ...props });

        const updated = yield* stack.deploy(prod());

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

        // The default pool is gone, so its node shape describes no node.
        const reshaped = yield* stack.plan(
          prod({ machineType: "e2-standard-4", initialNodeCount: 3 }),
        );
        expect(reshaped.resources.App.action).not.toBe("replace");
        // GKE only creates default-pool with the cluster, so restoring it replaces.
        expect(
          (yield* stack.plan(prod({ removeDefaultNodePool: false }))).resources.App.action,
        ).toBe("replace");
        // Secondary ranges are fixed at creation.
        expect(
          (yield* stack.plan(
            prod({
              ipAllocationPolicy: { useIpAliases: true, clusterSecondaryRangeName: "pods-b" },
            }),
          )).resources.App,
        ).toMatchObject({ action: "replace", deleteFirst: true });

        // Deletion protection blocks a replacement and a destroy until it is turned off.
        yield* stack.deploy(prod({ deletionProtection: true }));
        yield* Effect.gen(function* () {
          const blockedReplace = yield* stack
            .plan(prod({ deletionProtection: true, location: CAPACITY_ZONE_2 }))
            .pipe(Effect.flip);
          expect(blockedReplace).toMatchObject({ _tag: "GCP.Container.ClusterDeletionProtected" });
          expect(Result.isFailure(yield* stack.destroy().pipe(Effect.result))).toBe(true);
          expect(
            (yield* container.getProjectsLocationsClusters({ name: created.name })).status,
          ).toEqual("RUNNING");
        }).pipe(
          // Never leave the cluster locked, even if an assertion fails.
          Effect.ensuring(Effect.ignore(stack.deploy(prod({ deletionProtection: false })))),
        );

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

test.provider.skipIf(!runLifecycle)(
  "runs autopilot nodes as a dedicated service account",
  (stack) =>
    withGkeClusterSlot(
      Effect.gen(function* () {
        const { project } = yield* GcpEnvironment.current;
        yield* stack.destroy();

        const autopilot = (serviceAccount?: string) =>
          Effect.gen(function* () {
            const nodes = yield* GCP.IAM.ServiceAccount("GkeNodes", {});
            const role = yield* GCP.IAM.Member("GkeNodesRole", {
              kind: "project",
              name: project,
              role: "roles/container.defaultNodeServiceAccount",
              member: Output.interpolate`serviceAccount:${nodes.email}`,
            });
            const cluster = yield* GCP.Container.Cluster("Autopilot", {
              location: CAPACITY_REGION,
              autopilot: true,
              // Grant the node role before GKE provisions any node.
              serviceAccount:
                serviceAccount ??
                Output.all(nodes.email, role.role).pipe(Output.map(([email]) => email)),
            });
            return { nodes, cluster };
          });

        const { nodes, cluster } = yield* stack.deploy(autopilot());

        expect(cluster.autopilot).toEqual(true);
        const fetched = yield* container.getProjectsLocationsClusters({
          name: cluster.name,
        });
        expect(fetched.autopilot?.enabled).toEqual(true);
        expect(fetched.autoscaling?.autoprovisioningNodePoolDefaults?.serviceAccount).toEqual(
          nodes.email,
        );

        // Redeploying the same identity leaves the cluster in place.
        expect((yield* stack.plan(autopilot(nodes.email))).resources.Autopilot.action).not.toBe(
          "replace",
        );
        // Autopilot fixes its nodes' identity at creation.
        expect(
          (yield* stack.plan(autopilot(`alchemy-other-nodes@${project}.iam.gserviceaccount.com`)))
            .resources.Autopilot.action,
        ).toBe("replace");

        yield* stack.destroy();

        const gone = yield* waitUntilGone(cluster.name);
        expect(gone).toEqual("gone");
      }),
    ).pipe(logLevel),
  // Autopilot create ~10 min, delete ~5 min.
  {
    tags: ["provider:gcp", "provider:gcp:container", "live"],
    timeout: 1_800_000,
    retry: 0,
  },
);

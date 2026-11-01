import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as Core from "@/Test/Core";
import * as container from "@distilled.cloud/gcp/container_v1";
import * as crm from "@distilled.cloud/gcp/cloudresourcemanager_v3";
import { describe, expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { dockerAvailable, expectProbe } from "../bindingHost.ts";
import ContainerBindingsHost, {
  App,
  slow,
  Workers,
  ZonalWorkers,
} from "./fixtures/bindings-host.ts";

const testOptions = { providers: GCP.providers() };
const { test, beforeAll, afterAll } = Test.make(testOptions);
const sharedStack = Core.scratchStack(testOptions, "ContainerBindings");

let baseUrl: string;
let hostAccount: string;
let project: string;
let cluster: { name: string; clusterId: string };
let pool: { name: string; nodePoolId: string };
let zonalPool: { nodePoolId: string };

/**
 * GKE has no per-cluster IAM policy: every Get binding grants
 * `roles/container.clusterViewer` on the project.
 */
const expectProjectGrants = Effect.gen(function* () {
  const policy = yield* crm.getIamPolicyProjects({
    resource: `projects/${project}`,
    body: { options: { requestedPolicyVersion: 3 } },
  });
  const roles = (policy.bindings ?? [])
    .filter((binding) =>
      (binding.members ?? []).includes(`serviceAccount:${hostAccount}`),
    )
    .map((binding) => ({ role: binding.role, condition: binding.condition }));
  expect(roles).toEqual([
    { role: "roles/container.clusterViewer", condition: undefined },
  ]);
});

describe.skipIf(!dockerAvailable || !slow)(
  "Container Bindings",
  {
    tags: [
      "provider:gcp",
      "provider:gcp:container",
      "provider:gcp:run",
      "live",
    ],
  },
  () => {
    beforeAll(
      Effect.gen(function* () {
        yield* sharedStack.destroy();
        const out = yield* sharedStack.deploy(
          Effect.gen(function* () {
            const host = yield* ContainerBindingsHost;
            const app = yield* App;
            const workers = yield* Workers;
            const zonal = yield* ZonalWorkers;
            return {
              uri: host.uri,
              serviceAccount: host.serviceAccount,
              project: app.project,
              cluster: { name: app.name, clusterId: app.clusterId },
              pool: { name: workers.name, nodePoolId: workers.nodePoolId },
              zonalPool: { nodePoolId: zonal.nodePoolId },
            };
          }),
        );
        baseUrl = out.uri!;
        hostAccount = out.serviceAccount!;
        project = out.project;
        cluster = out.cluster;
        pool = out.pool;
        zonalPool = out.zonalPool;
      }),
      { timeout: 2_400_000 },
    );

    afterAll(sharedStack.destroy(), { timeout: 1_800_000 });

    describe("GetCluster", () => {
      test.provider(
        "reads the cluster as the host's service account",
        (_stack) =>
          Effect.gen(function* () {
            const live = yield* expectProbe<container.Cluster>(
              baseUrl,
              "getCluster",
            );
            const actual = yield* container.getProjectsLocationsClusters({
              name: cluster.name,
            });
            expect(live.name).toEqual(cluster.clusterId);
            expect(live.status).toEqual("RUNNING");
            expect(live.endpoint).toEqual(actual.endpoint);
            yield* expectProjectGrants;
          }),
        {
          tags: ["provider:gcp", "provider:gcp:container", "live"],
          timeout: 600_000,
        },
      );
    });

    describe("GetNodePool", () => {
      test.provider(
        "reads the node pool as the host's service account",
        (_stack) =>
          Effect.gen(function* () {
            const live = yield* expectProbe<container.NodePool>(
              baseUrl,
              "getNodePool",
            );
            expect(live.name).toEqual(pool.nodePoolId);
            expect(live.config?.machineType).toEqual("e2-medium");
            expect(live.config?.spot).toEqual(true);
            yield* expectProjectGrants;
          }),
        {
          tags: ["provider:gcp", "provider:gcp:container", "live"],
          timeout: 600_000,
        },
      );
    });

    describe("GetClustersNodePool", () => {
      test.provider(
        "reads the zonal node pool as the host's service account",
        (_stack) =>
          Effect.gen(function* () {
            const live = yield* expectProbe<container.NodePool>(
              baseUrl,
              "getClustersNodePool",
            );
            expect(live.name).toEqual(zonalPool.nodePoolId);
            expect(live.config?.machineType).toEqual("e2-medium");
            yield* expectProjectGrants;
          }),
        {
          tags: ["provider:gcp", "provider:gcp:container", "live"],
          timeout: 600_000,
        },
      );
    });
  },
);

import * as GCP from "@/GCP";
import * as Effect from "effect/Effect";
import { serveProbes } from "../../bindingHost.ts";
import { CAPACITY_ZONE_2 } from "../../zones.ts";

/**
 * GKE cluster create and delete each take 5-10 minutes, so
 * `GCP_TEST_SLOW=1` opts in. The gate is forwarded to the host's
 * environment so the deployed runtime binds the same set.
 */
export const slow = !!process.env.GCP_TEST_SLOW && !process.env.FAST;

/**
 * The cluster lives for the whole describe block, so it cannot hold a
 * `withGkeClusterSlot` permit; it takes its own zone instead so it never
 * counts against the per-location cluster quota the slotted lifecycle tests
 * share in `CAPACITY_ZONE`.
 */
const ZONE = CAPACITY_ZONE_2;

// Pools stay empty (the probes only read metadata): every GKE node holds an external IP and the project
// allows only 8 IN_USE_ADDRESSES per region, shared by every capacity test.
const poolShape = {
  nodeCount: 0,
  machineType: "e2-medium",
  diskSizeGb: 20,
  spot: true,
} as const;

/** Zonal cluster GetCluster binds; declared only when {@link slow}. */
export const App = GCP.Container.Cluster("App", {
  location: ZONE,
  machineType: "e2-medium",
  initialNodeCount: 1,
  diskSizeGb: 20,
  spot: true,
});

/** Node pool (locations API) GetNodePool binds. */
export const Workers = Effect.gen(function* () {
  const cluster = yield* App;
  return yield* GCP.Container.NodePool("Workers", {
    cluster: cluster.name,
    ...poolShape,
  });
});

/** Node pool (zones API) GetClustersNodePool binds. */
export const ZonalWorkers = Effect.gen(function* () {
  const cluster = yield* App;
  return yield* GCP.Container.ClustersNodePool("ZonalWorkers", {
    cluster: cluster.clusterId,
    zone: ZONE,
    ...poolShape,
  });
});

const clusterProbes = Effect.gen(function* () {
  const getCluster = yield* GCP.Container.GetCluster(App);
  const getNodePool = yield* GCP.Container.GetNodePool(Workers);
  const getClustersNodePool =
    yield* GCP.Container.GetClustersNodePool(ZonalWorkers);
  return {
    getCluster: getCluster(),
    getNodePool: getNodePool(),
    getClustersNodePool: getClustersNodePool(),
  };
});

/**
 * Effect-native Cloud Run service exercising every GKE binding as its own
 * runtime service account. Deployed from {@link ../Bindings.test.ts}.
 */
export default class ContainerBindingsHost extends GCP.Function<ContainerBindingsHost>()(
  "ContainerBindingsHost",
  {
    main: import.meta.url,
    invokerIamDisabled: true,
    env: { GCP_TEST_SLOW: slow ? "1" : "" },
  },
  Effect.gen(function* () {
    const cluster = slow ? yield* clusterProbes : {};
    return { fetch: serveProbes({ ...cluster }) };
  }).pipe(
    Effect.provide(GCP.Container.GetClusterHttp),
    Effect.provide(GCP.Container.GetNodePoolHttp),
    Effect.provide(GCP.Container.GetClustersNodePoolHttp),
  ),
) {}

import * as GCP from "@/GCP";
import * as Effect from "effect/Effect";
import { serveProbes } from "../../bindingHost.ts";

/** Cluster → config → workstation, on the project's `default` network. */
export const Dev = Effect.gen(function* () {
  const cluster = yield* GCP.Workstations.WorkstationCluster("Dev", {
    location: "us-central1",
    network: "default",
    subnetwork: "default",
    labels: { env: "test" },
  });
  const config = yield* GCP.Workstations.WorkstationClustersWorkstationConfig(
    "Code",
    {
      workstationCluster: cluster.name,
      host: {
        gceInstance: {
          machineType: "e2-standard-2",
          poolSize: 0,
          bootDiskSizeGb: 30,
        },
      },
      labels: { env: "test" },
    },
  );
  const workstation =
    yield* GCP.Workstations.WorkstationClustersWorkstationConfigsWorkstation(
      "Mine",
      { workstationConfig: config.name, labels: { env: "test" } },
    );
  return { cluster, config, workstation };
});

/**
 * Effect-native Cloud Run service exercising every Cloud Workstations
 * binding as its own runtime service account. Deployed from
 * {@link ../Bindings.test.ts}.
 */
export default class WorkstationsBindingsHost extends GCP.Function<WorkstationsBindingsHost>()(
  "WorkstationsBindingsHost",
  { main: import.meta.url, invokerIamDisabled: true },
  Effect.gen(function* () {
    const { cluster, config, workstation } = yield* Dev;
    const getCluster = yield* GCP.Workstations.GetWorkstationCluster(cluster);
    const getConfig = yield* GCP.Workstations.GetWorkstationConfig(config);
    const getWorkstation = yield* GCP.Workstations.GetWorkstation(workstation);
    const generateAccessToken =
      yield* GCP.Workstations.GenerateAccessToken(workstation);
    const start = yield* GCP.Workstations.StartWorkstation(workstation);
    const stop = yield* GCP.Workstations.StopWorkstation(workstation);

    return {
      fetch: serveProbes({
        getWorkstationCluster: getCluster().pipe(
          Effect.map((live) => ({ name: live.name, network: live.network })),
        ),
        getWorkstationConfig: getConfig().pipe(
          Effect.map((live) => ({
            name: live.name,
            machineType: live.host?.gceInstance?.machineType,
          })),
        ),
        getWorkstation: getWorkstation().pipe(
          Effect.map((live) => ({ name: live.name, state: live.state })),
        ),
        generateAccessToken: generateAccessToken({
          body: { ttl: "600s" },
        }).pipe(
          Effect.map((token) => ({
            hasToken: (token.accessToken ?? "").length > 0,
            expireTime: token.expireTime,
          })),
        ),
        startWorkstation: start().pipe(
          Effect.map((operation) => ({ name: operation.name })),
        ),
        stopWorkstation: stop().pipe(
          Effect.map((operation) => ({ name: operation.name })),
        ),
      }),
    };
  }).pipe(
    Effect.provide(GCP.Workstations.GetWorkstationClusterHttp),
    Effect.provide(GCP.Workstations.GetWorkstationConfigHttp),
    Effect.provide(GCP.Workstations.GetWorkstationHttp),
    Effect.provide(GCP.Workstations.GenerateAccessTokenHttp),
    Effect.provide(GCP.Workstations.StartWorkstationHttp),
    Effect.provide(GCP.Workstations.StopWorkstationHttp),
  ),
) {}

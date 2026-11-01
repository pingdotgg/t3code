import * as GCP from "@/GCP";
import * as Effect from "effect/Effect";
import { serveProbes } from "../../bindingHost.ts";

/** PSC-enabled cluster (no VPC network slot needed). */
export const Db = GCP.AlloyDB.Cluster("Db", {
  location: "us-central1",
  pscConfig: { pscEnabled: true },
  initialUser: { user: "postgres", password: "AlchemyTest1" },
  automatedBackupPolicy: { enabled: false },
  continuousBackupConfig: { enabled: false },
});

export const Primary = Effect.gen(function* () {
  const cluster = yield* Db;
  return yield* GCP.AlloyDB.Instance("Primary", {
    cluster: cluster.name,
    instanceType: "PRIMARY",
    machineConfig: { cpuCount: 2 },
  });
});

export const Snapshot = Effect.gen(function* () {
  // Depend on the primary: a backup needs a running instance to snapshot.
  const instance = yield* Primary;
  return yield* GCP.AlloyDB.Backup("Snapshot", {
    clusterName: instance.clusterName,
  });
});

export const AppUser = Effect.gen(function* () {
  const instance = yield* Primary;
  return yield* GCP.AlloyDB.ClustersUser("AppUser", {
    cluster: instance.clusterName,
    password: "AlchemyUser1",
    databaseRoles: ["alloydbsuperuser"],
  });
});

/**
 * Effect-native Cloud Run service exercising every AlloyDB binding as its
 * own runtime service account. Deployed from {@link ../Bindings.test.ts}.
 */
export default class AlloyDbBindingsHost extends GCP.Function<AlloyDbBindingsHost>()(
  "AlloyDbBindingsHost",
  { main: import.meta.url, invokerIamDisabled: true },
  Effect.gen(function* () {
    const getCluster = yield* GCP.AlloyDB.GetCluster(Db);
    const getInstance = yield* GCP.AlloyDB.GetInstance(Primary);
    const getConnectionInfo = yield* GCP.AlloyDB.GetConnectionInfo(Primary);
    const getBackup = yield* GCP.AlloyDB.GetBackup(Snapshot);
    const getUser = yield* GCP.AlloyDB.GetUser(AppUser);

    return {
      fetch: serveProbes({
        getCluster: getCluster(),
        getInstance: getInstance(),
        getConnectionInfo: getConnectionInfo(),
        getBackup: getBackup(),
        getUser: getUser(),
      }),
    };
  }).pipe(
    Effect.provide(GCP.AlloyDB.GetClusterHttp),
    Effect.provide(GCP.AlloyDB.GetInstanceHttp),
    Effect.provide(GCP.AlloyDB.GetConnectionInfoHttp),
    Effect.provide(GCP.AlloyDB.GetBackupHttp),
    Effect.provide(GCP.AlloyDB.GetUserHttp),
  ),
) {}

import * as GCP from "@/GCP";
import * as Effect from "effect/Effect";
import { serveProbes } from "../../bindingHost.ts";

/** Instance GetInstance / GetCluster are granted on. */
export const Db = GCP.Bigtable.Instance("Db", {
  clusters: {
    cluster: {
      location: "us-central1-b",
      serveNodes: 1,
      defaultStorageType: "HDD",
    },
  },
});

/** The instance's cluster, managed as its own resource. */
export const Nodes = Effect.gen(function* () {
  const instance = yield* Db;
  return yield* GCP.Bigtable.Cluster("Nodes", {
    instance: instance.name,
    clusterId: "cluster",
    location: "us-central1-b",
    serveNodes: 1,
    defaultStorageType: "HDD",
  });
});

/** Table GetTable is granted on. */
export const Rows = Effect.gen(function* () {
  const instance = yield* Db;
  return yield* GCP.Bigtable.Table("Rows", {
    instance: instance.name,
    columnFamilies: { cf: { gcRule: { maxNumVersions: 1 } } },
  });
});

/**
 * Effect-native Cloud Run service exercising every Bigtable binding as its
 * own runtime service account. Deployed from {@link ../Bindings.test.ts}.
 */
export default class BigtableBindingsHost extends GCP.Function<BigtableBindingsHost>()(
  "BigtableBindingsHost",
  { main: import.meta.url, invokerIamDisabled: true },
  Effect.gen(function* () {
    const getInstance = yield* GCP.Bigtable.GetInstance(Db);
    const getCluster = yield* GCP.Bigtable.GetCluster(Nodes);
    const getTable = yield* GCP.Bigtable.GetTable(Rows);

    return {
      fetch: serveProbes({
        getInstance: getInstance(),
        getCluster: getCluster(),
        getTable: getTable(),
      }),
    };
  }).pipe(
    Effect.provide(GCP.Bigtable.GetInstanceHttp),
    Effect.provide(GCP.Bigtable.GetClusterHttp),
    Effect.provide(GCP.Bigtable.GetTableHttp),
  ),
) {}

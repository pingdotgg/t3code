import * as GCP from "@/GCP";
import * as Effect from "effect/Effect";
import { serveProbes } from "../../bindingHost.ts";

export const ITEMS_DDL =
  "CREATE TABLE Items (\n  Id STRING(36) NOT NULL,\n) PRIMARY KEY(Id)";

export const Db = GCP.Spanner.Instance("Db", {
  config: "regional-us-central1",
  processingUnits: 100,
});

/** Database `GetDdl` reads (roles/spanner.databaseReader). */
export const Schema = Effect.gen(function* () {
  const instance = yield* Db;
  return yield* GCP.Spanner.Database("Schema", {
    instance: instance.name,
    extraStatements: [ITEMS_DDL],
  });
});

/** Database `ExecuteSql` queries (roles/spanner.databaseUser). */
export const App = Effect.gen(function* () {
  const instance = yield* Db;
  return yield* GCP.Spanner.Database("App", {
    instance: instance.name,
    extraStatements: [ITEMS_DDL],
  });
});

/**
 * Effect-native Cloud Run service exercising every Spanner binding as its
 * own runtime service account. Deployed from {@link ../Bindings.test.ts}.
 */
export default class SpannerBindingsHost extends GCP.Function<SpannerBindingsHost>()(
  "SpannerBindingsHost",
  { main: import.meta.url, invokerIamDisabled: true },
  Effect.gen(function* () {
    const getInstance = yield* GCP.Spanner.GetInstance(Db);
    const getDdl = yield* GCP.Spanner.GetDdl(Schema);
    const executeSql = yield* GCP.Spanner.ExecuteSql(App);

    return {
      fetch: serveProbes({
        getInstance: getInstance(),
        getDdl: getDdl(),
        executeSql: executeSql({
          sql: "SELECT COUNT(*) AS n FROM Items WHERE Id != @id",
          params: { id: "none" },
          paramTypes: { id: { code: "STRING" } },
        }),
      }),
    };
  }).pipe(
    Effect.provide(GCP.Spanner.GetInstanceHttp),
    Effect.provide(GCP.Spanner.GetDdlHttp),
    Effect.provide(GCP.Spanner.ExecuteSqlHttp),
  ),
) {}

import * as Drizzle from "@/Drizzle/Postgres.ts";
import * as GCP from "@/GCP";
import { sql } from "drizzle-orm";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { serveProbes } from "../../bindingHost.ts";

/** Test-only password; the test writes it into {@link Password}. */
export const USER_PASSWORD = "Alchemy-bindings-test-1";

export const Db = Effect.gen(function* () {
  // Shared-core, zonal, no backups: the cheapest Cloud SQL there is.
  const instance = yield* GCP.SQL.Instance("BindingsDb", {
    databaseVersion: "POSTGRES_17",
    edition: "ENTERPRISE",
    tier: "db-f1-micro",
    availabilityType: "ZONAL",
    backupEnabled: false,
    deletionProtectionEnabled: false,
    dataApiAccess: true,
  });
  const database = yield* GCP.SQL.Database("App", {
    instance: instance.instanceName,
  });
  const user = yield* GCP.SQL.User("AppUser", {
    instance: instance.instanceName,
    password: USER_PASSWORD,
  });
  // The Data API only accepts regional secrets in the instance's region.
  const password = yield* GCP.SecretManager.LocationsSecret("AppPassword", {
    location: instance.region,
  });
  return { instance, database, user, password };
});

/**
 * Effect-native Cloud Run service exercising every Cloud SQL binding as
 * its own runtime service account. Deployed from
 * {@link ../Bindings.test.ts}.
 */
export default class SqlBindingsHost extends GCP.Function<SqlBindingsHost>()(
  "SqlBindingsHost",
  { main: import.meta.url, invokerIamDisabled: true },
  Effect.gen(function* () {
    const { instance, database, user, password } = yield* Db;
    const connect = yield* GCP.SQL.Connect(instance, {
      database,
      user,
      passwordSecret: password,
    });
    const executeSql = yield* GCP.SQL.ExecuteSql(instance);
    const getInstance = yield* GCP.SQL.GetInstance(instance);
    const getUser = yield* GCP.SQL.GetUser(user);
    const db = yield* Drizzle.Postgres(
      connect.pipe(Effect.map((info) => info.url)),
    );
    const databaseName = yield* database.databaseName;
    const userName = yield* user.userName;
    const secretName = yield* password.name;

    return {
      fetch: serveProbes({
        connect: Effect.gen(function* () {
          const info = yield* connect;
          // A real query over the `/cloudsql` socket: the Cloud SQL
          // connector authorizes it with the host's cloudsql.client grant.
          const rows = yield* db.execute<{ user: string; database: string }>(
            sql`SELECT current_user AS "user", current_database() AS "database"`,
            "objects",
          );
          return {
            connectionName: info.connectionName,
            socketPath: info.socketPath,
            username: info.username,
            database: info.database,
            passwordMatches: Redacted.value(info.password) === USER_PASSWORD,
            rows,
          };
        }),
        executeSql: Effect.gen(function* () {
          const response = yield* executeSql({
            body: {
              database: yield* databaseName,
              user: yield* userName,
              passwordSecretVersion: `${yield* secretName}/versions/latest`,
              sqlStatement: "SELECT current_user AS who, 41 + 1 AS answer",
            },
          });
          return {
            status: response.status,
            columns: (response.results?.[0]?.columns ?? []).map(
              (column) => column.name,
            ),
            values: (response.results?.[0]?.rows?.[0]?.values ?? []).map(
              (cell) => cell.value,
            ),
          };
        }),
        getInstance: getInstance().pipe(
          Effect.map((live) => ({
            name: live.name,
            state: live.state,
            connectionName: live.connectionName,
          })),
        ),
        getUser: getUser().pipe(
          Effect.map((live) => ({ name: live.name, instance: live.instance })),
        ),
      }),
    };
  }).pipe(
    Effect.provide(GCP.SQL.ConnectHttp),
    Effect.provide(GCP.SQL.ExecuteSqlHttp),
    Effect.provide(GCP.SQL.GetInstanceHttp),
    Effect.provide(GCP.SQL.GetUserHttp),
  ),
) {}

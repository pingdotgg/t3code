import * as Alchemy from "alchemy";
import * as Drizzle from "alchemy/Drizzle";
import * as GCP from "alchemy/GCP";
import * as Effect from "effect/Effect";

export const database = Effect.gen(function* () {
  // Shared-core, zonal, no backups: the cheapest Postgres Cloud SQL runs.
  // No authorized networks — the only ways in are the Cloud SQL connector
  // (Cloud Run's `/cloudsql` socket, IAM-gated) and the Data API used for
  // migrations.
  const instance = yield* GCP.SQL.Instance("Postgres", {
    databaseVersion: "POSTGRES_17",
    edition: "ENTERPRISE",
    tier: "db-f1-micro",
    availabilityType: "ZONAL",
    backupEnabled: false,
    dataApiAccess: true,
  });
  const db = yield* GCP.SQL.Database("App", {
    instance: instance.instanceName,
  });

  // Generated once and kept in state; the regional secret below is where
  // the Data API (migrations) and the service (runtime) read it from.
  const password = yield* Alchemy.Random("AppPasswordValue", { bytes: 24 });
  const user = yield* GCP.SQL.User("AppUser", {
    instance: instance.instanceName,
    password: password.text,
    // The user owns the migrated tables, so Postgres refuses to drop it
    // while the database still exists; deleting the instance removes it.
    deletionPolicy: "ABANDON",
  });
  // The Data API only accepts regional secrets in the instance's region.
  const passwordSecret = yield* GCP.SecretManager.LocationsSecret(
    "AppPassword",
    { location: instance.region },
  );

  // drizzle-kit regenerates ./migrations whenever src/schema.ts changes.
  const schema = yield* Drizzle.Schema("Schema", {
    schema: "./src/schema.ts",
    out: "./migrations",
  });

  return { instance, db, user, password, passwordSecret, schema };
});

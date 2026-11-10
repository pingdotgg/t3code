import * as Drizzle from "@alchemy.run/drizzle";
import * as GCP from "@alchemy.run/gcp";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";

export const database = Effect.gen(function* () {
  // Shared-core, zonal, no backups: the cheapest Postgres Cloud SQL runs.
  // No authorized networks — the only ways in are the Cloud SQL connector
  // (Cloud Run's `/cloudsql` socket, IAM-gated) and the Data API that
  // applies migrations.
  const instance = yield* GCP.SQL.Instance("Postgres", {
    databaseVersion: "POSTGRES_17",
    edition: "ENTERPRISE",
    tier: "db-f1-micro",
    availabilityType: "ZONAL",
    backup: { enabled: false },
    dataApiAccess: true,
  });

  // Generated once and kept in state; the regional secret below is where
  // the service reads it at runtime.
  const password = yield* Alchemy.Random("AppPasswordValue", { bytes: 24 });
  const user = yield* GCP.SQL.User("AppUser", {
    instance: instance.instanceName,
    password: password.text,
    // The user owns the migrated tables, so Postgres refuses to drop it
    // while the database still exists; deleting the instance removes it.
    deletionPolicy: "ABANDON",
  });
  const passwordSecret = yield* GCP.SecretManager.LocationsSecret("AppPassword", {
    location: instance.region,
  });

  // drizzle-kit regenerates ./migrations whenever src/schema.ts changes.
  const schema = yield* Drizzle.Schema("Schema", {
    schema: "./src/schema.ts",
    out: "./migrations",
  });

  // Every deploy applies pending migrations through the Cloud SQL Data
  // API, logged in as the app user, so the user owns the tables.
  const db = yield* GCP.SQL.Database("App", {
    instance: instance.instanceName,
    migrations: schema,
    migrationsUser: user.userName,
    migrationsPassword: password.text,
  });

  return { instance, db, user, password, passwordSecret, schema };
});

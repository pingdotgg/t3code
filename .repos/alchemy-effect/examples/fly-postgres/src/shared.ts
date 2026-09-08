import * as Drizzle from "alchemy/Drizzle";
import * as Fly from "alchemy/Fly";

export const API_PORT = 3000;

/**
 * Shared token for the fixture's `POST /migrate` route. Fly Managed
 * Postgres is only reachable on the org's private network, so migrations
 * are applied THROUGH the deployed Service (which is in-network) — the
 * integ test reads the generated SQL locally and posts it here. A
 * checked-in constant is fine for this throwaway demo database; real apps
 * should use a deploy-time secret.
 */
export const MIGRATE_TOKEN = "fly-postgres-example-migrate";

export const Site = Fly.App("Site", {
  enableSubdomains: true,
});

/**
 * Drizzle schema generation. The generated SQL under `./migrations` is
 * applied through the Api service's `/migrate` route (see api.ts) — MPG
 * hostnames don't resolve outside the org's private network, so the
 * in-network Service is the data plane for DDL too.
 */
export const Schema = Drizzle.Schema("app-schema", {
  schema: "./src/schema.ts",
  out: "./migrations",
});

export const Db = Fly.Postgres("Db", { region: "iad" });

export const PublicIp = Fly.IpAssignment("Shared", {
  app: Site,
  type: "shared_v4",
});

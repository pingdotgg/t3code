import { PostgresDatabase } from "@/Planetscale/Postgres/PostgresDatabase.ts";
import { PostgresRole } from "@/Planetscale/Postgres/PostgresRole.ts";
import * as Effect from "effect/Effect";

/**
 * PlanetScale Postgres used as the container's DATABASE_URL. Like Neon,
 * PlanetScale has no local emulator — the pooled URL is a cloud host, so
 * the loopback rewrite must leave it alone.
 *
 * The database name is deterministic so reruns adopt the same cluster
 * instead of provisioning a new PS_10 every time (same trick as the
 * PlanetScale Hyperdrive fixture).
 */
export const PlanetscaleHostRole = Effect.gen(function* () {
  const database = yield* PostgresDatabase("PlanetscaleHostDb", {
    name: "alchemy-container-pg-host",
    region: { slug: "us-east" },
    clusterSize: "PS_10",
  });
  return yield* PostgresRole("PlanetscaleHostRole", {
    database,
    inheritedRoles: ["postgres"],
  });
});

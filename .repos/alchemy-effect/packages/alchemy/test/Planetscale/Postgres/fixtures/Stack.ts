import * as Cloudflare from "@/Cloudflare/index.ts";
import * as Planetscale from "@/Planetscale/index.ts";
import * as Effect from "effect/Effect";

/**
 * Shared Planetscale + Cloudflare wiring used by the Hyperdrive
 * fixture worker. A long-lived staging Postgres database (named
 * deterministically so reruns adopt the same resource) owns a feature
 * branch + role; Hyperdrive points at `role.origin` so the worker can
 * connect over Postgres-on-PSBouncer.
 */
export const PlanetscaleDb = Effect.gen(function* () {
  const database = yield* Planetscale.PostgresDatabase("HyperdriveTestDb", {
    name: "alchemy-postgres-hyperdrive",
    region: { slug: "us-east" },
    clusterSize: "PS_10",
  });

  const branch = yield* Planetscale.PostgresBranch("HyperdriveTestBranch", {
    database,
    migrationsDir:
      "./packages/alchemy/test/Planetscale/Postgres/fixtures/migrations",
  });

  const role = yield* Planetscale.PostgresRole("HyperdriveTestRole", {
    database,
    branch,
    inheritedRoles: ["postgres"],
  });

  return { database, branch, role };
});

export const Hyperdrive = Effect.gen(function* () {
  const { role } = yield* PlanetscaleDb;
  return yield* Cloudflare.Hyperdrive("HyperdriveTestEdge", {
    origin: role.origin,
  });
});

import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Drizzle from "alchemy/Drizzle";
import * as Planetscale from "alchemy/Planetscale";
import * as Effect from "effect/Effect";

/**
 * A Drizzle schema + PlanetScale Postgres database + feature branch. The
 * branch's `migrationsDir` is wired to the schema resource's `out` output, so
 * the provider order becomes:
 *
 *   1. `Drizzle.Schema` regenerates pending migration SQL files.
 *   2. `Planetscale.PostgresBranch` scans the directory and applies new
 *      migrations transactionally.
 */
export const PlanetscaleDb = Effect.gen(function* () {
  const { stage } = yield* Alchemy.Stack;

  const schema = yield* Drizzle.Schema("app-schema", {
    schema: "./src/schema.ts",
    out: "./migrations",
  });

  // Stages are organised in two tiers:
  //
  //   - `staging-*` stages own the long-lived PlanetScale database.
  //   - `pr-*` stages reference the parallel `staging-pr-*` database
  //     and only own ephemeral compute (branch + role + Hyperdrive + Worker).
  //
  // Deriving `staging-${stage}` instead of a single global "staging"
  // keeps each test / PR isolated. Locally (`dev_<user>`, etc.) we create
  // a fresh database.
  const database = stage.startsWith("pr-")
    ? yield* Planetscale.PostgresDatabase.ref("app-db", {
        stage: `staging-${stage}`,
      })
    : yield* Planetscale.PostgresDatabase("app-db", {
        region: { slug: "us-east" },
        clusterSize: "PS_10",
      });

  const branch = yield* Planetscale.PostgresBranch("app-branch", {
    database,
    migrationsDir: schema.out,
  });

  const role = yield* Planetscale.PostgresRole("app-role", {
    database,
    branch,
    inheritedRoles: ["postgres"],
  });

  return { database, branch, role, schema };
});

export const Hyperdrive: Effect.Effect<Cloudflare.Hyperdrive, never, any> =
  Effect.gen(function* () {
    const { role } = yield* PlanetscaleDb;
    return yield* Cloudflare.Hyperdrive("app-hyperdrive", {
      origin: role.origin,
    });
  });

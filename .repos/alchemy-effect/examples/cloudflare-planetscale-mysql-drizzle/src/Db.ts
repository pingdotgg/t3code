import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Drizzle from "alchemy/Drizzle";
import * as Planetscale from "alchemy/Planetscale";
import * as Effect from "effect/Effect";

/**
 * A Drizzle schema + PlanetScale MySQL database + feature branch. The
 * branch's `migrations` prop is wired to the schema resource, so
 * the provider order becomes:
 *
 *   1. `Drizzle.Schema` regenerates pending migration SQL files.
 *   2. `Planetscale.MySQLBranch` scans the directory and applies new
 *      migrations transactionally.
 */
export const PlanetscaleDb = Effect.gen(function* () {
  const { stage } = yield* Alchemy.Stack;

  const schema = yield* Drizzle.Schema("app-schema", {
    schema: "./src/schema.ts",
    out: "./migrations",
    dialect: "mysql",
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
    ? yield* Planetscale.MySQLDatabase.ref("app-db", {
        stage: `staging-${stage}`,
      })
    : yield* Planetscale.MySQLDatabase("app-db", {
        region: { slug: "us-east" },
        clusterSize: "PS_10",
      });

  const branch = yield* Planetscale.MySQLBranch("app-branch", {
    database,
    isProduction: false,
    migrations: schema,
  });

  const password = yield* Planetscale.MySQLPassword("app-password", {
    database,
    branch,
    role: "readwriter",
  });

  return { database, branch, password };
});

export const Hyperdrive: Effect.Effect<
  Cloudflare.Hyperdrive.Connection,
  never,
  any
> = Effect.gen(function* () {
  const { password } = yield* PlanetscaleDb;
  return yield* Cloudflare.Hyperdrive.Connection("app-hyperdrive", {
    origin: password.origin,
    caching: { disabled: true },
  });
});

import type { MysqlClient } from "@effect/sql-mysql2/MysqlClient";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Planetscale from "alchemy/Planetscale";
import * as Alchemy from "alchemy";
import * as RemovalPolicy from "alchemy/RemovalPolicy";
import type { EffectMysql2Database } from "drizzle-orm/effect-mysql2";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { relayDatabaseMode } from "./dbConfig.ts";

export class RelayDb extends Context.Service<
  RelayDb,
  EffectMysql2Database & {
    readonly $client: MysqlClient;
  }
>()("t3code-relay/db/RelayDb") {}

export class RelayTransactions extends Context.Service<
  RelayTransactions,
  {
    readonly withTransaction: RelayDb["Service"]["$client"]["withTransaction"];
  }
>()("t3code-relay/db/RelayTransactions") {
  static readonly layer = Layer.effect(
    RelayTransactions,
    Effect.gen(function* () {
      const db = yield* RelayDb;
      return RelayTransactions.of({
        withTransaction: db.$client.withTransaction,
      });
    }),
  );
}

// Unlike Postgres, alchemy has no automatic Drizzle.Schema generation for
// MySQL (drizzle-kit exposes no programmatic mysql API): migrations are
// generated manually with `pnpm exec drizzle-kit generate` (drizzle.config.ts)
// and checked in; deploys apply whatever is committed here.
const mysqlMigrationsDir = "migrations/mysql";

export const PlanetscaleDatabase = Effect.gen(function* () {
  const { stage } = yield* Alchemy.Stack;
  const mode = relayDatabaseMode(stage);

  // The retired Postgres database stays in the stack (prod only) until the
  // Vitess cutover has soaked: prod must own BOTH databases while DMS
  // replicates data across and while rollback (redeploying the previous
  // commit, which flips Hyperdrive back to this role's origin) is still on
  // the table. The migrations dir is the frozen checked-in history — every
  // file is already recorded in relay_migrations, so deploys no-op against
  // it. Remove this block together with migrations/postgres once the old
  // database is decommissioned
  // (docs/operations/relay-postgres-to-vitess-migration.md).
  if (mode === "shared-database") {
    const postgresDatabase = yield* Planetscale.PostgresDatabase("RelayPostgresDatabase", {
      name: "t3coderelay",
      region: { slug: "us-west" },
      clusterSize: "PS_20",
      migrationsDir: "migrations/postgres",
      migrationsTable: "relay_migrations",
      replicas: 2,
    }).pipe(RemovalPolicy.retain());
    yield* Planetscale.PostgresRole("RelayPostgresRuntimeRole", {
      database: postgresDatabase,
      inheritedRoles: ["pg_read_all_data", "pg_write_all_data"],
    });
  }

  const database =
    mode === "shared-database"
      ? // Same resource + props as the provisioning PR that created this
        // database (with its baseline already applied) ahead of the cutover,
        // so this deploy no-ops on the database itself.
        yield* Planetscale.MySQLDatabase("RelayMysqlDatabase", {
          name: "t3coderelay-vitess",
          region: { slug: "us-west" },
          clusterSize: "PS_20",
          migrationsDir: mysqlMigrationsDir,
          migrationsTable: "relay_migrations",
          replicas: 2,
        }).pipe(RemovalPolicy.retain())
      : yield* Planetscale.MySQLDatabase.ref("RelayMysqlDatabase", {
          stage: "prod",
        });
  const branch =
    mode === "stage-branch"
      ? yield* Planetscale.MySQLBranch("RelayMysqlBranch", {
          database,
          isProduction: false,
          migrationsDir: mysqlMigrationsDir,
          migrationsTable: "relay_migrations",
        })
      : undefined;

  const runtimePassword = yield* Planetscale.MySQLPassword("RelayMysqlRuntimePassword", {
    database,
    ...(branch ? { branch } : {}),
    role: "readwriter",
  });

  return { branch, database, runtimePassword };
});

export const RelayHyperdrive = Effect.gen(function* () {
  const { runtimePassword } = yield* PlanetscaleDatabase;
  return yield* Cloudflare.Hyperdrive.Connection("RelayHyperdrive", {
    origin: runtimePassword.origin,
    caching: {
      disabled: true,
    },
    originConnectionLimit: 20,
  });
});

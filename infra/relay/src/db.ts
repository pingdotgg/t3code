import type { PgClient } from "@effect/sql-pg/PgClient";
import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Drizzle from "@alchemy.run/drizzle";
import * as Planetscale from "@alchemy.run/planetscale";
import * as Alchemy from "alchemy";
import * as Output from "alchemy/Output";
import * as RemovalPolicy from "alchemy/RemovalPolicy";
import type { EffectPgDatabase } from "drizzle-orm/effect-postgres";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { relayDatabaseMode } from "./dbConfig.ts";

export class RelayDb extends Context.Service<
  RelayDb,
  EffectPgDatabase & {
    readonly $client: PgClient;
  }
>()("t3code-relay/db/RelayDb") {}

/**
 * The cluster's read replicas, a few milliseconds behind the primary. Only for
 * hot reads that tolerate missing a write committed just before them.
 * Unprovided outside prod, where `readDb` falls back to the primary.
 */
export class RelayReadDb extends Context.Service<RelayReadDb, RelayDb["Service"]>()(
  "t3code-relay/db/RelayReadDb",
) {}

export const readDb = Effect.gen(function* () {
  const replica = yield* Effect.serviceOption(RelayReadDb);
  return Option.isSome(replica) ? replica.value : yield* RelayDb;
});

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

export const PlanetscaleDatabase = Effect.gen(function* () {
  const { stage } = yield* Alchemy.Stack;
  const schema = yield* Drizzle.Schema("RelaySchema", {
    schema: "./src/persistence/schema.ts",
    out: "./migrations/postgres",
    dialect: "postgres",
  });

  const mode = relayDatabaseMode(stage);
  const database =
    mode === "shared-database"
      ? yield* Planetscale.PostgresDatabase("RelayPostgresDatabase", {
          name: "t3coderelay",
          region: { slug: "us-west" },
          clusterSize: "PS_160",
          migrations: { dir: schema.out, table: "relay_migrations" },
          replicas: 2,
        }).pipe(RemovalPolicy.retain())
      : yield* Planetscale.PostgresDatabase.ref("RelayPostgresDatabase", {
          stage: "prod",
        });
  const branch =
    mode === "stage-branch"
      ? yield* Planetscale.PostgresBranch("RelayPostgresBranch", {
          database,
          migrations: { dir: schema.out, table: "relay_migrations" },
        })
      : undefined;

  const runtimeRole = yield* Planetscale.PostgresRole("RelayPostgresRuntimeRole", {
    database,
    ...(branch ? { branch } : {}),
    inheritedRoles: ["pg_read_all_data", "pg_write_all_data"],
  });

  return { branch, database, runtimeRole };
});

export const RelayHyperdrive = Effect.gen(function* () {
  const { runtimeRole } = yield* PlanetscaleDatabase;
  return yield* Cloudflare.Hyperdrive.Connection("RelayHyperdrive", {
    origin: runtimeRole.origin,
    caching: {
      disabled: true,
    },
    originConnectionLimit: 40,
  });
});

/** Prod only: stage branches have no read replicas. */
export const RelayReplicaHyperdrive = Effect.gen(function* () {
  const { stage } = yield* Alchemy.Stack;
  if (relayDatabaseMode(stage) !== "shared-database") return Option.none();
  const { runtimeRole } = yield* PlanetscaleDatabase;
  const hyperdrive = yield* Cloudflare.Hyperdrive.Connection("RelayReplicaHyperdrive", {
    // PlanetScale routes a `|replica` username across the cluster's read replicas.
    origin: Output.map(runtimeRole.origin, (origin) => ({
      ...origin,
      user: `${origin.user}|replica`,
    })),
    caching: {
      disabled: true,
    },
    originConnectionLimit: 40,
  });
  return Option.some(hyperdrive);
});

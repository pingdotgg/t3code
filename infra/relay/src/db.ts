import type { PgClient } from "@effect/sql-pg/PgClient";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Drizzle from "alchemy/Drizzle";
import * as Planetscale from "alchemy/Planetscale";
import * as Alchemy from "alchemy";
import * as RemovalPolicy from "alchemy/RemovalPolicy";
import type { EffectPgDatabase } from "drizzle-orm/effect-postgres";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Random from "effect/Random";
import * as Schema from "effect/Schema";
import { and, eq, sql } from "drizzle-orm";

import { relayDatabaseMode } from "./dbConfig.ts";
import { relayEnvironmentLifecycleLeases } from "./persistence/schema.ts";

export class RelayDb extends Context.Service<
  RelayDb,
  EffectPgDatabase & {
    readonly $client: PgClient;
  }
>()("t3code-relay/db/RelayDb") {}

export class EnvironmentLifecycleLeasePersistenceError extends Schema.TaggedErrorClass<EnvironmentLifecycleLeasePersistenceError>()(
  "EnvironmentLifecycleLeasePersistenceError",
  {
    userId: Schema.String,
    environmentId: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to acquire the lifecycle lease for user '${this.userId}', environment '${this.environmentId}'`;
  }
}

function withEnvironmentLock<A, E, R>(
  db: RelayDb["Service"],
  input: { readonly userId: string; readonly environmentId: string },
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E | EnvironmentLifecycleLeasePersistenceError, R> {
  return Effect.gen(function* () {
    const ownerId = `${yield* Random.nextInt}:${yield* Random.nextInt}`;
    const acquire = (): Effect.Effect<void, EnvironmentLifecycleLeasePersistenceError> =>
      Effect.suspend(() =>
        Effect.gen(function* () {
          const expiresAt = sql<string>`to_char((now() + interval '30 seconds') at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;
          const rows = yield* db
            .insert(relayEnvironmentLifecycleLeases)
            .values({ ...input, ownerId, expiresAt })
            .onConflictDoUpdate({
              target: [
                relayEnvironmentLifecycleLeases.userId,
                relayEnvironmentLifecycleLeases.environmentId,
              ],
              set: { ownerId, expiresAt },
              setWhere: sql`${relayEnvironmentLifecycleLeases.expiresAt}::timestamptz <= now()`,
            })
            .returning({ ownerId: relayEnvironmentLifecycleLeases.ownerId })
            .pipe(
              Effect.mapError(
                (cause) => new EnvironmentLifecycleLeasePersistenceError({ ...input, cause }),
              ),
            );
          if (rows[0]?.ownerId !== ownerId) {
            yield* Effect.sleep("50 millis");
            return yield* acquire();
          }
        }),
      );
    const release = db
      .delete(relayEnvironmentLifecycleLeases)
      .where(
        and(
          eq(relayEnvironmentLifecycleLeases.userId, input.userId),
          eq(relayEnvironmentLifecycleLeases.environmentId, input.environmentId),
          eq(relayEnvironmentLifecycleLeases.ownerId, ownerId),
        ),
      )
      .pipe(
        Effect.catch((error) =>
          Effect.logWarning("failed to release relay environment lifecycle lease", {
            ...input,
            ownerId,
            error,
          }),
        ),
      );
    // Public relay requests are capped at nine seconds. A 30-second lease keeps
    // a live request fenced while guaranteeing crash recovery without manual
    // connection cleanup or provider I/O inside a transaction.
    yield* acquire();
    return yield* effect.pipe(Effect.ensuring(release));
  });
}

export class RelayTransactions extends Context.Service<
  RelayTransactions,
  {
    readonly withTransaction: RelayDb["Service"]["$client"]["withTransaction"];
    readonly withEnvironmentLock: <A, E, R>(
      input: { readonly userId: string; readonly environmentId: string },
      effect: Effect.Effect<A, E, R>,
    ) => Effect.Effect<A, E | EnvironmentLifecycleLeasePersistenceError, R>;
  }
>()("t3code-relay/db/RelayTransactions") {
  static readonly layer = Layer.effect(
    RelayTransactions,
    Effect.gen(function* () {
      const db = yield* RelayDb;
      return RelayTransactions.of({
        withTransaction: db.$client.withTransaction,
        withEnvironmentLock: (input, effect) => withEnvironmentLock(db, input, effect),
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
          clusterSize: "PS_20",
          migrationsDir: schema.out,
          migrationsTable: "relay_migrations",
          replicas: 2,
        }).pipe(RemovalPolicy.retain())
      : yield* Planetscale.PostgresDatabase.ref("RelayPostgresDatabase", {
          stage: "prod",
        });
  const branch =
    mode === "stage-branch"
      ? yield* Planetscale.PostgresBranch("RelayPostgresBranch", {
          database,
          migrationsDir: schema.out,
          migrationsTable: "relay_migrations",
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
    originConnectionLimit: 20,
  });
});

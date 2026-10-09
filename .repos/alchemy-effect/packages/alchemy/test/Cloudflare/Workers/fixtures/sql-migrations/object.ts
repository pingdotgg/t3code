import * as Cloudflare from "@/Cloudflare";
import { applySqlMigrations } from "@/Cloudflare/Workers/SqlMigrationsApply.ts";
import * as Drizzle from "@/Drizzle/Cloudflare.ts";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import { relations, users } from "./schema.ts";

export type HistoryRow = {
  id: number;
  hash: string;
  created_at: number | null;
  name: string;
  applied_at: string | null;
};

type State = Cloudflare.DurableObjectState["Service"];

const history = (state: State, table: string) =>
  state.storage.sql
    .exec<HistoryRow>(
      `SELECT id, hash, created_at, name, applied_at FROM "${table}" ORDER BY id`,
    )
    .pipe(Effect.flatMap((cursor) => cursor.toArray()));

const tables = (state: State) =>
  state.storage.sql
    .exec<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
    )
    .pipe(Effect.flatMap((cursor) => cursor.toArray()));

export class MigratedObject extends Cloudflare.DurableObject<MigratedObject>()(
  "SqlMigratedObject",
  Effect.gen(function* () {
    const snapshot = yield* Cloudflare.SqlMigrations(
      "./test/Cloudflare/Workers/fixtures/sql-migrations/drizzle",
    );
    return Effect.gen(function* () {
      const state = yield* Cloudflare.DurableObjectState;
      const db = yield* Drizzle.DurableObject({
        migrations: snapshot,
        relations,
      });
      const boots = ((yield* state.storage.get<number>("boots")) ?? 0) + 1;
      yield* state.storage.put("boots", boots);

      const inspect = () =>
        Effect.gen(function* () {
          const payload = yield* state.storage.sql
            .exec<{ length: number }>(
              "SELECT length(value) AS length FROM payload",
            )
            .pipe(Effect.flatMap((cursor) => cursor.one()));
          const rows = yield* db.query.users.findMany({
            with: { posts: true },
          });
          return {
            tag: snapshot._tag,
            table: snapshot.table,
            records: snapshot.records.map((record) => ({
              name: record.name,
              hash: record.hash,
              created_at: record.createdAtMillis ?? null,
            })),
            boots,
            payloadLength: payload.length,
            history: yield* history(state, snapshot.table),
            tables: yield* tables(state),
            users: rows
              .map((row) => ({
                name: row.name,
                posts: row.posts.map((post) => post.title),
              }))
              .sort((left, right) => left.name.localeCompare(right.name)),
          };
        });

      return {
        inspect,
        addUser: (name: string) =>
          db.insert(users).values({ name }).pipe(Effect.asVoid),
        repeat: () =>
          Effect.gen(function* () {
            yield* Drizzle.DurableObject({ migrations: snapshot, relations });
            yield* snapshot.apply();
            return yield* inspect();
          }).pipe(Effect.provideService(Cloudflare.DurableObjectState, state)),
        reset: () =>
          state.abort("sql migration reactivation", { retryAlarm: false }),
      };
    });
  }),
) {}

export class CustomMigratedObject extends Cloudflare.DurableObject<CustomMigratedObject>()(
  "CustomSqlMigratedObject",
  Effect.gen(function* () {
    const snapshot = yield* Cloudflare.SqlMigrations({
      dir: "./test/Cloudflare/Workers/fixtures/sql-migrations/flat",
      table: "fixture_migrations",
    });
    return Effect.gen(function* () {
      const state = yield* Cloudflare.DurableObjectState;
      yield* snapshot.apply().pipe(Effect.orDie);
      const inspect = () =>
        Effect.gen(function* () {
          const rows = yield* state.storage.sql
            .exec<{ value: string }>(
              "SELECT value FROM flat_values ORDER BY id",
            )
            .pipe(Effect.flatMap((cursor) => cursor.toArray()));
          return {
            tag: snapshot._tag,
            table: snapshot.table,
            names: snapshot.records.map((record) => record.name),
            history: yield* history(state, snapshot.table),
            tables: yield* tables(state),
            values: rows.map((row) => row.value),
          };
        });
      return {
        inspect,
        repeat: () =>
          snapshot
            .apply()
            .pipe(
              Effect.andThen(inspect),
              Effect.provideService(Cloudflare.DurableObjectState, state),
            ),
      };
    });
  }),
) {}

export class MigrationScenarios extends Cloudflare.DurableObject<MigrationScenarios>()(
  "SqlMigrationScenarios",
  Effect.gen(function* () {
    const snapshot = yield* Cloudflare.SqlMigrations({
      dir: "./test/Cloudflare/Workers/fixtures/sql-migrations/drizzle",
    });
    const broken = yield* Cloudflare.SqlMigrations(
      "./test/Cloudflare/Workers/fixtures/sql-migrations/rollback",
    );
    return Effect.gen(function* () {
      const state = yield* Cloudflare.DurableObjectState;
      return {
        rollback: () =>
          Effect.gen(function* () {
            const result = yield* broken.apply().pipe(Effect.result);
            const rows = yield* state.storage.sql
              .exec<{ value: string }>(
                "SELECT value FROM stable_values ORDER BY id",
              )
              .pipe(Effect.flatMap((cursor) => cursor.toArray()));
            return {
              error: Result.isFailure(result) ? result.failure._tag : null,
              history: yield* history(state, broken.table),
              tables: yield* tables(state),
              values: rows.map((row) => row.value),
              names: broken.records.map((record) => record.name),
            };
          }).pipe(Effect.provideService(Cloudflare.DurableObjectState, state)),
        adopt: () =>
          Effect.gen(function* () {
            const first = snapshot.records[0]!;
            yield* Drizzle.DurableObject({
              migrations: { migrations: { [first.name]: first.sql } },
              relations,
            });
            const before = yield* history(state, "__drizzle_migrations");
            yield* snapshot.apply();
            const adopted = yield* history(state, snapshot.table);
            yield* snapshot.apply();
            const db = yield* Drizzle.DurableObject({
              migrations: snapshot,
              relations,
            });
            return {
              before,
              after: yield* history(state, "__drizzle_migrations"),
              adopted,
              repeated: yield* history(state, snapshot.table),
              names: snapshot.records.map((record) => record.name),
              users: (yield* db.query.users.findMany({
                with: { posts: true },
              })).map((row) => ({
                name: row.name,
                posts: row.posts.map((post) => post.title),
              })),
            };
          }).pipe(Effect.provideService(Cloudflare.DurableObjectState, state)),
        conflict: (empty: boolean = false) =>
          Effect.gen(function* () {
            const first = snapshot.records[0]!;
            const db = yield* Drizzle.DurableObject({
              migrations: { migrations: { [first.name]: first.sql } },
              relations,
            });
            const before = yield* history(state, "__drizzle_migrations");
            const result = yield* applySqlMigrations({
              _tag: snapshot._tag,
              table: snapshot.table,
              records: empty ? [] : snapshot.records.slice(1),
            }).pipe(Effect.result);
            return {
              error: Result.isFailure(result) ? result.failure._tag : null,
              before,
              after: yield* history(state, "__drizzle_migrations"),
              tables: yield* tables(state),
              users: (yield* db.select().from(users)).map((row) => row.name),
            };
          }).pipe(Effect.provideService(Cloudflare.DurableObjectState, state)),
      };
    });
  }),
) {}

import * as Cloudflare from "@alchemy.run/cloudflare";
import { applySqlMigrations } from "@alchemy.run/cloudflare/Workers/SqlMigrationsApply";
import * as Drizzle from "@alchemy.run/drizzle/Cloudflare";
import * as Cause from "effect/Cause";
import * as Channel from "effect/Channel";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as Stream from "effect/Stream";
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
    .exec<HistoryRow>(`SELECT id, hash, created_at, name, applied_at FROM "${table}" ORDER BY id`)
    .pipe(Effect.flatMap((cursor) => cursor.toArray()));

const tables = (state: State) =>
  state.storage.sql
    .exec<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
    .pipe(Effect.flatMap((cursor) => cursor.toArray()));

const cursorMethods = (state: State) =>
  Effect.gen(function* () {
    const sql = state.storage.sql;
    yield* sql.exec("CREATE TABLE IF NOT EXISTS cursor_values (value INTEGER PRIMARY KEY)");
    yield* sql.exec("DELETE FROM cursor_values");
    const insert = sql.exec("INSERT INTO cursor_values VALUES (1), (2), (3)");
    const count = () =>
      sql
        .exec<{ count: number }>("SELECT count(*) AS count FROM cursor_values")
        .pipe(Effect.flatMap((cursor) => cursor.one()));
    const beforeInsert = yield* count();
    // A write takes effect when exec runs, even when its cursor is discarded.
    yield* insert;
    const afterInsert = yield* count();

    const cursor = yield* sql.exec<{ value: number }>(
      "SELECT value FROM cursor_values ORDER BY value",
    );
    const { next, toArray, one, raw, rowsRead, rowsWritten } = cursor;
    const columns = cursor.columnNames;
    const stableMembers =
      next === cursor.next &&
      toArray === cursor.toArray &&
      one === cursor.one &&
      raw === cursor.raw &&
      rowsRead === cursor.rowsRead &&
      rowsWritten === cursor.rowsWritten;
    const readsBefore = yield* rowsRead;
    const first = yield* next();
    const readsAfterFirst = yield* rowsRead;
    const second = yield* next();
    const last = yield* one();
    const readsAfterAll = yield* rowsRead;
    return {
      beforeInsert: beforeInsert.count,
      afterInsert: afterInsert.count,
      stableMembers,
      columns,
      sameColumnsAfterConsumption: columns === cursor.columnNames,
      first,
      second,
      last,
      exhausted: yield* next(),
      remaining: yield* toArray(),
      rawRemaining: yield* Stream.runCollect(raw()),
      reads: [readsBefore, readsAfterFirst, readsAfterAll],
      writes: yield* rowsWritten,
    };
  });

const cursorStreams = (state: State) =>
  Effect.gen(function* () {
    const sql = state.storage.sql;
    // Cross a Stream chunk boundary while retaining only a few rows.
    const cursor = yield* sql.exec<{ value: number }>(
      "WITH RECURSIVE numbers(value) AS (SELECT 0 UNION ALL SELECT value + 1 FROM numbers WHERE value < 4999) SELECT value FROM numbers",
    );
    const stream = cursor.pipe(
      Stream.filter((row) => row.value % 1000 === 0),
      Stream.map((row) => row.value),
    );
    // Building a Stream must leave consumption to the eventual consumer.
    const first = yield* cursor.next();
    const values = yield* Stream.runCollect(stream);
    const repeated = yield* Stream.runCollect(stream);

    const channelCursor = yield* sql.exec<{ value: number }>(
      "SELECT 1 AS value UNION ALL SELECT 2 UNION ALL SELECT 3",
    );
    const channel = Stream.toChannel(channelCursor);
    const sameChannel = channel === Stream.toChannel(channelCursor);
    const channelFirst = yield* channelCursor.next();
    const channelValues = (yield* Channel.runCollect(channel)).flat();
    const channelRepeated = yield* Stream.runCollect(Stream.fromChannel(channel));

    const rawCursor = yield* sql.exec<{
      value: number;
      label: string | null;
      bytes: ArrayBuffer;
    }>("SELECT 1 AS value, 'first' AS label, X'01' AS bytes UNION ALL SELECT 2, NULL, X'000102ff'");
    const { raw } = rawCursor;
    const rawStream = raw<[number, string | null, ArrayBuffer]>();
    const rawFirst = yield* rawCursor.next();
    const rawValues = yield* rawStream.pipe(
      Stream.map(([value, label, bytes]) => [value, label, Array.from(new Uint8Array(bytes))]),
      Stream.runCollect,
    );
    return {
      first,
      values,
      repeated,
      sameChannel,
      channelFirst,
      channelValues,
      channelRepeated,
      rawFirst: rawFirst.value?.value,
      rawValues,
      rawRemaining: yield* rawCursor.toArray(),
    };
  });

const defects = <A, R>(effect: Effect.Effect<A, never, R>) =>
  effect.pipe(
    Effect.matchCause({
      onFailure: (cause) =>
        cause.reasons.map((reason) => ({
          tag: reason._tag,
          name:
            Cause.isDieReason(reason) && reason.defect instanceof Error ? reason.defect.name : null,
          message:
            Cause.isDieReason(reason) && reason.defect instanceof Error
              ? reason.defect.message
              : null,
        })),
      onSuccess: () => [],
    }),
  );

const cursorErrors = (state: State) =>
  Effect.gen(function* () {
    const sql = state.storage.sql;
    const failures = [];
    for (const query of [
      "SELECT 1 AS value WHERE 0",
      "SELECT 1 AS value UNION ALL SELECT 2",
      "SELECT FROM",
    ]) {
      failures.push({
        wrapped: yield* defects(sql.exec(query).pipe(Effect.flatMap((cursor) => cursor.one()))),
        native: yield* defects(Effect.sync(() => sql.raw.exec(query).one())),
      });
    }
    return {
      failures,
      recovered: yield* sql
        .exec<{ value: number }>("SELECT 7 AS value")
        .pipe(Effect.flatMap((cursor) => cursor.one())),
    };
  });

export type CursorMethods = Effect.Success<ReturnType<typeof cursorMethods>>;
export type CursorStreams = Effect.Success<ReturnType<typeof cursorStreams>>;
export type CursorErrors = Effect.Success<ReturnType<typeof cursorErrors>>;

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
            .exec<{ length: number }>("SELECT length(value) AS length FROM payload")
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
        cursorMethods: () => cursorMethods(state),
        cursorStreams: () => cursorStreams(state),
        cursorErrors: () => cursorErrors(state),
        addUser: (name: string) => db.insert(users).values({ name }).pipe(Effect.asVoid),
        repeat: () =>
          Effect.gen(function* () {
            yield* Drizzle.DurableObject({ migrations: snapshot, relations });
            yield* snapshot.apply();
            return yield* inspect();
          }).pipe(Effect.provideService(Cloudflare.DurableObjectState, state)),
        reset: () => state.abort("sql migration reactivation", { retryAlarm: false }),
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
            .exec<{ value: string }>("SELECT value FROM flat_values ORDER BY id")
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
              .exec<{ value: string }>("SELECT value FROM stable_values ORDER BY id")
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

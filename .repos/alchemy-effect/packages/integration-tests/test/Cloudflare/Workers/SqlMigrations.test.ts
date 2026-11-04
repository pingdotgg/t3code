import * as Cloudflare from "@alchemy.run/cloudflare";
import { CloudflareApiLive } from "@alchemy.run/cloudflare/Providers";
import { describe, expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as workers from "@distilled.cloud/cloudflare/workers";
import * as Alchemy from "alchemy";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as Schedule from "effect/Schedule";
import { requestWorker, waitUntilStable } from "../Utils/WorkerRequest.ts";
import type {
  CursorErrors,
  CursorMethods,
  CursorStreams,
  HistoryRow,
} from "./fixtures/sql-migrations/object.ts";
import SqlMigrationsWorker from "./fixtures/sql-migrations/worker.ts";

type MigratedState = {
  tag: string;
  table: string;
  records: { name: string; hash: string; created_at: number | null }[];
  boots: number;
  payloadLength: number;
  history: HistoryRow[];
  tables: { name: string }[];
  users: { name: string; posts: string[] }[];
};

type CustomState = {
  tag: string;
  table: string;
  names: string[];
  history: HistoryRow[];
  tables: { name: string }[];
  values: string[];
};

type RollbackState = {
  error: string | null;
  history: HistoryRow[];
  tables: { name: string }[];
  values: string[];
  names: string[];
};

type AdoptionState = {
  before: HistoryRow[];
  after: HistoryRow[];
  adopted: HistoryRow[];
  repeated: HistoryRow[];
  names: string[];
  users: { name: string; posts: string[] }[];
};

class WorkerNotReady extends Data.TaggedError("WorkerNotReady")<{
  status: number;
  message: string;
}> {}

const migrationNames = ["20240101000000_init", "20240102000000_posts"];
const seedUsers = [{ name: "seed", posts: ["pending migration"] }];

for (const dev of [true, false]) {
  const state = dev ? Alchemy.inMemoryState() : Cloudflare.state();
  describe(
    `SqlMigrations (${dev ? "local" : "live"})`,
    { tags: ["provider:cloudflare", "provider:cloudflare:worker"] },
    () => {
      const options = {
        providers: Cloudflare.providers(),
        state,
        dev,
        stage: dev ? Test.defaultStage() : `${Test.defaultStage()}_sql_migrations_live`,
      };
      // Leading destroy closes its harness scope; deployment needs a fresh one.
      const cleanup = Test.make(options);
      const { test, beforeAll, afterAll, deploy, destroy } = Test.make(options);
      const Stack = Alchemy.Stack(
        dev ? "SqlMigrationsLocalStack" : "SqlMigrationsLiveStack",
        { providers: Cloudflare.providers(), state },
        Effect.gen(function* () {
          const worker = yield* SqlMigrationsWorker;
          return {
            url: worker.url.as<string>(),
            workerName: worker.workerName,
            accountId: worker.accountId,
          };
        }),
      );
      cleanup.beforeAll(cleanup.destroy(Stack), { timeout: 120_000 });
      const stack = beforeAll(
        Effect.gen(function* () {
          const deployed = yield* deploy(Stack);
          expect(deployed.url).toMatch(dev ? /^http:\/\/localhost:\d+/ : /^https:\/\//);
          const client = yield* HttpClient.HttpClient;
          // Readiness never invokes a migration or repeats an application
          // write. A new version reaches Cloudflare's hosts one at a time, so
          // `/health` must answer ready several times in a row.
          yield* waitUntilStable(
            `SQL Worker at ${deployed.url}`,
            Effect.gen(function* () {
              const response = yield* client.get(`${deployed.url}/health`);
              const body = yield* response.text;
              if (response.status !== 200 || body !== "sql-migrations:ready") {
                return yield* Effect.fail(
                  new WorkerNotReady({
                    status: response.status,
                    message: `GET ${deployed.url}/health: ${response.status}: ${body}`,
                  }),
                );
              }
              return true;
            }).pipe(
              Effect.timeout("2 seconds"),
              Effect.tapError((error) => Effect.logWarning("SQL Worker readiness", error)),
              Effect.orElseSucceed(() => false),
            ),
            { spacing: "2 seconds", timeout: "60 seconds" },
          );
          // `/health` never reaches the Durable Object namespace, which a fresh
          // deploy also rolls out host by host (first calls fail with an opaque
          // "internal error"). Probe it through a dedicated object name: it
          // migrates its own isolated database, so the objects the tests
          // inspect still activate exactly once.
          yield* waitUntilStable(
            `SQL Durable Object namespace at ${deployed.url}`,
            requestWorker(HttpClientRequest.get(`${deployed.url}/state?name=readiness-probe`)).pipe(
              Effect.map((response) => response.status === 200),
              Effect.catchTag("WorkerNotPropagated", () => Effect.succeed(false)),
            ),
            { timeout: "60 seconds" },
          );
          // New actor names can still hit namespace propagation independently.
          // Warm the cursor actors with reads; never retry cursor operations.
          yield* Effect.forEach(
            ["cursor-methods", "cursor-streams", "cursor-errors"],
            (name) =>
              waitUntilStable(
                `SQL cursor object ${name}`,
                requestWorker(HttpClientRequest.get(`${deployed.url}/state?name=${name}`)).pipe(
                  Effect.map((response) => response.status === 200),
                  Effect.catchTag("WorkerNotPropagated", () => Effect.succeed(false)),
                ),
                { timeout: "30 seconds" },
              ),
            { concurrency: 3 },
          );
          return deployed;
        }),
        { timeout: 120_000 },
      );
      afterAll(
        Effect.gen(function* () {
          const deployed = yield* Effect.exit(stack);
          yield* destroy(Stack);
          if (dev || Exit.isFailure(deployed)) return;
          const deleted = yield* workers
            .getScript({
              accountId: deployed.value.accountId,
              scriptName: deployed.value.workerName,
            })
            .pipe(
              Effect.as(false),
              Effect.catchTag(["WorkerNotFound", "WorkerHasNoVersions"], () =>
                Effect.succeed(true),
              ),
              Effect.repeat({
                while: (deleted) => !deleted,
                schedule: Schedule.spaced("1 second"),
                times: 8,
              }),
              Effect.timeout("15 seconds"),
              Effect.provide(CloudflareApiLive()),
              Effect.scoped,
            );
          expect(deleted).toBe(true);
        }),
        { timeout: 120_000 },
      );

      const json = <A>(method: "GET" | "POST", path: string) =>
        Effect.gen(function* () {
          const { url } = yield* stack;
          // A fresh workers.dev route reaches edge nodes one at a time; retry
          // only Cloudflare's not-yet-routed page, never application errors.
          const response = yield* requestWorker(
            method === "GET"
              ? HttpClientRequest.get(`${url}${path}`)
              : HttpClientRequest.post(`${url}${path}`),
          );
          if (response.status !== 200) {
            return yield* Effect.fail(
              new Error(`${method} ${url}${path}: ${response.status}: ${yield* response.text}`),
            );
          }
          return (yield* response.json) as A;
        });
      const read = (name: string) => json<MigratedState>("GET", `/state?name=${name}`);

      test(
        "SQL cursor methods remain bound and report live SQLite metadata",
        Effect.gen(function* () {
          const result = yield* json<CursorMethods>("POST", "/cursor/methods?name=cursor-methods");
          expect(result.beforeInsert).toBe(0);
          expect(result.afterInsert).toBe(3);
          expect(result.stableMembers).toBe(true);
          expect(result.columns).toEqual(["value"]);
          expect(result.sameColumnsAfterConsumption).toBe(true);
          expect(result.first).toEqual({ done: false, value: { value: 1 } });
          expect(result.second).toEqual({ done: false, value: { value: 2 } });
          expect(result.last).toEqual({ value: 3 });
          expect(result.exhausted.done).toBe(true);
          expect(result.remaining).toEqual([]);
          expect(result.rawRemaining).toEqual([]);
          // SQLite may prefetch a row, but re-running the same statistic Effect
          // must observe the later reads rather than its first result.
          expect(result.reads[1]).toBeGreaterThanOrEqual(result.reads[0]!);
          expect(result.reads[2]).toBeGreaterThan(result.reads[0]!);
          expect(result.reads[2]).toBeGreaterThanOrEqual(3);
          expect(result.writes).toBe(0);
        }),
        { tags: [...(dev ? ["local"] : ["live"])], timeout: 90_000 },
      );

      test(
        "SQL cursor Stream, Channel, and raw views lazily consume the same SQLite cursor",
        Effect.gen(function* () {
          const result = yield* json<CursorStreams>("GET", "/cursor/streams?name=cursor-streams");
          expect(result.first).toEqual({ done: false, value: { value: 0 } });
          expect(result.values).toEqual([1000, 2000, 3000, 4000]);
          expect(result.repeated).toEqual([]);
          expect(result.sameChannel).toBe(true);
          expect(result.channelFirst).toEqual({ done: false, value: { value: 1 } });
          expect(result.channelValues).toEqual([{ value: 2 }, { value: 3 }]);
          expect(result.channelRepeated).toEqual([]);
          expect(result.rawFirst).toBe(1);
          expect(result.rawValues).toEqual([[2, null, [0, 1, 2, 255]]]);
          expect(result.rawRemaining).toEqual([]);
        }),
        { tags: [...(dev ? ["local"] : ["live"])], timeout: 90_000 },
      );

      test(
        "SQL cursor one and exec preserve native SQLite defects",
        Effect.gen(function* () {
          const result = yield* json<CursorErrors>("GET", "/cursor/errors?name=cursor-errors");
          expect(result.failures).toHaveLength(3);
          for (const failure of result.failures) {
            expect(failure.wrapped).toEqual(failure.native);
            expect(failure.wrapped).toHaveLength(1);
            expect(failure.wrapped[0]!.tag).toBe("Die");
            expect(failure.wrapped[0]!.name).toBe("Error");
            expect(failure.wrapped[0]!.message).toBeTruthy();
          }
          expect(result.recovered).toEqual({ value: 7 });
        }),
        { tags: [...(dev ? ["local"] : ["live"])], timeout: 90_000 },
      );

      test(
        "activation applies modern migrations, relations, and a snapshot larger than 5 KB",
        Effect.gen(function* () {
          const state = yield* read("activation");
          expect(state.tag).toBe("Cloudflare.SqlMigrations");
          expect(state.table).toBe("__alchemy_migrations");
          expect(state.boots).toBe(1);
          expect(state.payloadLength).toBe(6144);
          expect(state.users).toEqual(seedUsers);
          expect(state.records.map((record) => record.name)).toEqual(migrationNames);
          expect(state.history).toHaveLength(2);
          expect(
            state.history.map(({ name, hash, created_at }) => ({ name, hash, created_at })),
          ).toEqual(state.records);
          for (const row of state.history) {
            expect(row.hash).toMatch(/^[a-f0-9]{64}$/);
            expect(row.applied_at).not.toBeNull();
          }
          expect(state.tables.map((table) => table.name)).toContain("__alchemy_migrations");
          expect(state.tables.map((table) => table.name)).not.toContain("__drizzle_migrations");
        }),
        { tags: [...(dev ? ["local"] : ["live"])], timeout: 90_000 },
      );

      test(
        "fresh object names each migrate their own isolated database",
        Effect.gen(function* () {
          const first = yield* read("isolation-first");
          const second = yield* read("isolation-second");
          expect(first.users).toEqual(seedUsers);
          expect(second.users).toEqual(seedUsers);
          expect(first.history.map((row) => row.name)).toEqual(migrationNames);
          expect(second.history.map((row) => row.name)).toEqual(migrationNames);
          yield* json("POST", "/users?name=isolation-first&user=only-first");
          expect((yield* read("isolation-first")).users).toEqual([
            { name: "only-first", posts: [] },
            ...seedUsers,
          ]);
          expect((yield* read("isolation-second")).users).toEqual(seedUsers);
        }),
        { tags: [...(dev ? ["local"] : ["live"])], timeout: 90_000 },
      );

      test(
        "repeat application and real object reactivation preserve data and history",
        Effect.gen(function* () {
          const before = yield* read("reactivation");
          yield* json("POST", "/users?name=reactivation&user=preserved");
          const repeated = yield* json<MigratedState>("POST", "/repeat?name=reactivation");
          expect(repeated.history).toEqual(before.history);
          expect(repeated.users).toEqual([{ name: "preserved", posts: [] }, ...seedUsers]);
          const reset = yield* json<{ reset: boolean }>("POST", "/reset?name=reactivation");
          expect(reset.reset).toBe(true);
          const reactivated = yield* read("reactivation");
          expect(reactivated.boots).toBe(before.boots + 1);
          expect(reactivated.history).toEqual(before.history);
          expect(reactivated.users).toEqual(repeated.users);
          expect(reactivated.payloadLength).toBe(6144);
        }),
        { tags: [...(dev ? ["local"] : ["live"])], timeout: 90_000 },
      );

      test(
        "direct activation reads flat SQL files and uses only the custom history table",
        Effect.gen(function* () {
          const state = yield* json<CustomState>("GET", "/custom?name=custom");
          expect(state.tag).toBe("Cloudflare.SqlMigrations");
          expect(state.table).toBe("fixture_migrations");
          expect(state.names).toEqual(["0001_values.sql", "0002_values.sql"]);
          expect(state.history.map((row) => row.name)).toEqual(state.names);
          expect(state.values).toEqual(["first", "second"]);
          const tableNames = state.tables.map((table) => table.name);
          expect(tableNames).toContain("fixture_migrations");
          expect(tableNames).not.toContain("__alchemy_migrations");
          expect(tableNames).not.toContain("__drizzle_migrations");
          const repeated = yield* json<CustomState>("POST", "/custom/repeat?name=custom");
          expect(repeated).toEqual(state);
        }),
        { tags: [...(dev ? ["local"] : ["live"])], timeout: 90_000 },
      );

      test(
        "failed SQL rolls back DML and DDL without recording the failed migration",
        Effect.gen(function* () {
          const failed = yield* json<RollbackState>("POST", "/rollback?name=rollback");
          expect(failed.error).toBe("MigrationError");
          expect(failed.names).toEqual(["0001_stable.sql", "0002_broken.sql"]);
          expect(failed.history.map((row) => row.name)).toEqual(["0001_stable.sql"]);
          expect(failed.values).toEqual(["committed"]);
          expect(failed.tables.map((table) => table.name)).not.toContain("must_roll_back");
          // A second explicit attempt must not duplicate the committed predecessor.
          const repeated = yield* json<RollbackState>("POST", "/rollback?name=rollback");
          expect(repeated).toEqual(failed);
        }),
        { tags: [...(dev ? ["local"] : ["live"])], timeout: 90_000 },
      );

      test(
        "adopts modern Drizzle history once, freezes its table, and applies only pending SQL",
        Effect.gen(function* () {
          const state = yield* json<AdoptionState>("POST", "/adopt?name=adoption");
          expect(state.names).toEqual(migrationNames);
          expect(state.before).toHaveLength(1);
          expect(state.before[0]!.name).toBe(migrationNames[0]);
          expect(state.before[0]!.hash).toBe("");
          expect(state.before[0]!.applied_at).toMatch(
            /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
          );
          expect(state.after).toEqual(state.before);
          expect(state.adopted).toHaveLength(2);
          expect(state.adopted[0]).toEqual(state.before[0]);
          expect(state.adopted.map((row) => row.name)).toEqual(migrationNames);
          expect(state.repeated).toEqual(state.adopted);
          expect(state.users).toEqual(seedUsers);
        }),
        { tags: [...(dev ? ["local"] : ["live"])], timeout: 90_000 },
      );

      for (const empty of [false, true]) {
        test(
          `${empty ? "empty migration directory" : "unmatched Drizzle history"} rejects adoption without changing schema or history`,
          Effect.gen(function* () {
            const state = yield* json<{
              error: string | null;
              before: HistoryRow[];
              after: HistoryRow[];
              tables: { name: string }[];
              users: string[];
            }>("POST", `/conflict?name=conflict-${empty}${empty ? "&empty" : ""}`);
            expect(state.error).toBe("MigrationHistoryConflictError");
            expect(state.before).toHaveLength(1);
            expect(state.before[0]!.name).toBe(migrationNames[0]);
            expect(state.after).toEqual(state.before);
            expect(state.users).toEqual(["seed"]);
            expect(state.tables.map((table) => table.name)).not.toContain("__alchemy_migrations");
            expect(state.tables.map((table) => table.name)).not.toContain("posts");
          }),
          { tags: [...(dev ? ["local"] : ["live"])], timeout: 90_000 },
        );
      }
    },
  );
}

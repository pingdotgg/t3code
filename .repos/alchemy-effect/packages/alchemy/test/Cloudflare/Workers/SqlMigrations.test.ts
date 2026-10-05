import * as Cloudflare from "@/Cloudflare";
import * as Alchemy from "@/index.ts";
import * as Test from "@/Test/Alchemy";
import { describe, expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/http/HttpClient";
import type { HistoryRow } from "./fixtures/sql-migrations/object.ts";
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
        stage: dev
          ? Test.defaultStage()
          : `${Test.defaultStage()}_sql_migrations_live`,
      };
      // Leading destroy closes its harness scope; deployment needs a fresh one.
      const cleanup = Test.make(options);
      const { test, beforeAll, afterAll, deploy, destroy } = Test.make(options);
      const Stack = Alchemy.Stack(
        dev ? "SqlMigrationsLocalStack" : "SqlMigrationsLiveStack",
        { providers: Cloudflare.providers(), state },
        Effect.gen(function* () {
          const worker = yield* SqlMigrationsWorker;
          return { url: worker.url.as<string>() };
        }),
      );
      cleanup.beforeAll(cleanup.destroy(Stack), { timeout: 120_000 });
      const stack = beforeAll(
        Effect.gen(function* () {
          const deployed = yield* deploy(Stack);
          expect(deployed.url).toMatch(
            dev ? /^http:\/\/localhost:\d+/ : /^https:\/\//,
          );
          const client = yield* HttpClient.HttpClient;
          // Readiness never invokes a migration or repeats an application write.
          yield* Effect.gen(function* () {
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
          }).pipe(
            Effect.timeout("2 seconds"),
            Effect.tapError((error) =>
              Effect.logWarning("SQL Worker readiness", error),
            ),
            Effect.retry({ schedule: Schedule.spaced("3 seconds"), times: 10 }),
            Effect.timeout("45 seconds"),
          );
          return deployed;
        }),
        { timeout: 120_000 },
      );
      afterAll(destroy(Stack), { timeout: 120_000 });

      const json = <A>(method: "GET" | "POST", path: string) =>
        Effect.gen(function* () {
          const { url } = yield* stack;
          const client = yield* HttpClient.HttpClient;
          const response = yield* method === "GET"
            ? client.get(`${url}${path}`)
            : client.post(`${url}${path}`);
          if (response.status !== 200) {
            return yield* Effect.fail(
              new Error(
                `${method} ${url}${path}: ${response.status}: ${yield* response.text}`,
              ),
            );
          }
          return (yield* response.json) as A;
        });
      const read = (name: string) =>
        json<MigratedState>("GET", `/state?name=${name}`);

      test(
        "activation applies modern migrations, relations, and a snapshot larger than 5 KB",
        Effect.gen(function* () {
          const state = yield* read("activation");
          expect(state.tag).toBe("Cloudflare.SqlMigrations");
          expect(state.table).toBe("__alchemy_migrations");
          expect(state.boots).toBe(1);
          expect(state.payloadLength).toBe(6144);
          expect(state.users).toEqual(seedUsers);
          expect(state.records.map((record) => record.name)).toEqual(
            migrationNames,
          );
          expect(state.history).toHaveLength(2);
          expect(
            state.history.map(({ name, hash, created_at }) => ({
              name,
              hash,
              created_at,
            })),
          ).toEqual(state.records);
          for (const row of state.history) {
            expect(row.hash).toMatch(/^[a-f0-9]{64}$/);
            expect(row.applied_at).not.toBeNull();
          }
          expect(state.tables.map((table) => table.name)).toContain(
            "__alchemy_migrations",
          );
          expect(state.tables.map((table) => table.name)).not.toContain(
            "__drizzle_migrations",
          );
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
          const repeated = yield* json<MigratedState>(
            "POST",
            "/repeat?name=reactivation",
          );
          expect(repeated.history).toEqual(before.history);
          expect(repeated.users).toEqual([
            { name: "preserved", posts: [] },
            ...seedUsers,
          ]);
          const reset = yield* json<{ reset: boolean }>(
            "POST",
            "/reset?name=reactivation",
          );
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
          const repeated = yield* json<CustomState>(
            "POST",
            "/custom/repeat?name=custom",
          );
          expect(repeated).toEqual(state);
        }),
        { tags: [...(dev ? ["local"] : ["live"])], timeout: 90_000 },
      );

      test(
        "failed SQL rolls back DML and DDL without recording the failed migration",
        Effect.gen(function* () {
          const failed = yield* json<RollbackState>(
            "POST",
            "/rollback?name=rollback",
          );
          expect(failed.error).toBe("MigrationError");
          expect(failed.names).toEqual(["0001_stable.sql", "0002_broken.sql"]);
          expect(failed.history.map((row) => row.name)).toEqual([
            "0001_stable.sql",
          ]);
          expect(failed.values).toEqual(["committed"]);
          expect(failed.tables.map((table) => table.name)).not.toContain(
            "must_roll_back",
          );
          // A second explicit attempt must not duplicate the committed predecessor.
          const repeated = yield* json<RollbackState>(
            "POST",
            "/rollback?name=rollback",
          );
          expect(repeated).toEqual(failed);
        }),
        { tags: [...(dev ? ["local"] : ["live"])], timeout: 90_000 },
      );

      test(
        "adopts modern Drizzle history once, freezes its table, and applies only pending SQL",
        Effect.gen(function* () {
          const state = yield* json<AdoptionState>(
            "POST",
            "/adopt?name=adoption",
          );
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
            }>(
              "POST",
              `/conflict?name=conflict-${empty}${empty ? "&empty" : ""}`,
            );
            expect(state.error).toBe("MigrationHistoryConflictError");
            expect(state.before).toHaveLength(1);
            expect(state.before[0]!.name).toBe(migrationNames[0]);
            expect(state.after).toEqual(state.before);
            expect(state.users).toEqual(["seed"]);
            expect(state.tables.map((table) => table.name)).not.toContain(
              "__alchemy_migrations",
            );
            expect(state.tables.map((table) => table.name)).not.toContain(
              "posts",
            );
          }),
          { tags: [...(dev ? ["local"] : ["live"])], timeout: 90_000 },
        );
      }
    },
  );
}

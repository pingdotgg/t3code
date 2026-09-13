import { Action } from "@/Action";
import * as Cloudflare from "@/Cloudflare/index.ts";
import * as Alchemy from "@/index.ts";
import * as Test from "@/Test/Alchemy";
import * as d1 from "@distilled.cloud/cloudflare/d1";
import { expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as pathe from "pathe";
import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment.ts";

// `dev: true` runs local providers behind the RPC sidecar proxy by default,
// matching the process topology of the real `alchemy dev` command (see
// MakeOptions.sidecar in Test/Core.ts).
const { test, deploy, destroy } = Test.make({
  providers: Cloudflare.providers(),
  dev: true,
});

// The in-process topology: no RpcProviderProxy, so the RPC-backed local
// provider builds directly in this process with the un-gated
// `localRuntimeServices()` from its dual registration. Still a real
// production path — a programmatic `deploy({ dev: true })` without the
// `alchemy dev` CLI has no sidecar.
const { test: inProcessTest } = Test.make({
  providers: Cloudflare.providers(),
  dev: true,
  sidecar: false,
});

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const RpcMigrationStack = Alchemy.Stack(
  "D1RpcMigrationStack",
  {
    providers: Cloudflare.providers(),
    state: Alchemy.localState(),
  },
  Cloudflare.D1.Database("RpcMigratedDB", {
    migrations: pathe.resolve(import.meta.dirname, "fixtures/rpc-migrations"),
  }),
);

class WorkerNotReady extends Data.TaggedError("WorkerNotReady")<{
  status: number;
}> {}

const getJsonReady = (url: string) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const res = yield* client.get(url).pipe(
      Effect.flatMap((res) =>
        res.status === 200
          ? Effect.succeed(res)
          : Effect.fail(new WorkerNotReady({ status: res.status })),
      ),
      Effect.retry({
        while: (e): e is WorkerNotReady => e instanceof WorkerNotReady,
        // Cap the backoff: an uncapped exponential over 10 recurs sums to
        // ~8.5 minutes and turns a persistent non-200 into an apparent hang.
        schedule: Schedule.max([
          Schedule.min([
            Schedule.exponential("500 millis"),
            Schedule.spaced("2 seconds"),
          ]),
          Schedule.recurs(10),
        ]),
      }),
    );
    return yield* res.json;
  }).pipe(Effect.orDie);

/**
 * Regression test for #1007. Under the RPC proxy used by `alchemy dev` (the
 * default topology for `dev: true` tests), `localRuntimeServices()` is
 * intentionally omitted from the caller because RPC providers consume it in
 * the sidecar. D1's local provider is not an RPC provider, so its migration
 * lifecycle must provide the standalone gateway runtime explicitly.
 */
test(
  "D1 migrations apply with the alchemy dev RPC proxy",
  Effect.gen(function* () {
    yield* destroy(RpcMigrationStack);

    const database = yield* deploy(RpcMigrationStack);

    expect(database.databaseId).toMatch(/^dev:/);
    expect(Object.keys(database.migrationsHashes)).toEqual(["0001_notes.sql"]);

    yield* destroy(RpcMigrationStack);
  }).pipe(logLevel),
  { timeout: 120_000 },
);

/**
 * Counterpart of the #1007 regression above for the in-process topology:
 * without the proxy, the provider's migration lifecycle runs in this
 * process and must find the workerd runtime in its own layer (the dual
 * registration's `localRuntimeServices()`, real when un-gated).
 */
inProcessTest.provider(
  "D1 migrations apply in-process without the RPC proxy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const db = yield* stack.deploy(
        Cloudflare.D1.Database("InProcessMigratedDB", {
          migrations: pathe.resolve(
            import.meta.dirname,
            "fixtures/rpc-migrations",
          ),
        }),
      );

      expect(db.databaseId).toMatch(/^dev:/);
      expect(Object.keys(db.migrationsHashes)).toEqual(["0001_notes.sql"]);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 120_000 },
);

/**
 * Under `alchemy dev` the D1 Database resource is emulated by the local
 * provider (a `dev:` id, no cloud API calls) and the worker's `d1` binding
 * is lowered onto the local workerd D1 simulator (workerd's real
 * `cloudflare-internal:d1-api` over DO SQLite). This exercises DDL,
 * prepared statements, and reads through the native `env` binding.
 */
test.provider(
  "D1 database binding round-trips against the local simulator",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          const db = yield* Cloudflare.D1.Database("LocalDB");
          const worker = yield* Cloudflare.Worker("d1-local-worker", {
            main: pathe.resolve(
              import.meta.dirname,
              "fixtures/d1-local-worker.ts",
            ),
            env: { DB: db },
          });
          return { db, worker };
        }),
      );

      // The local provider fabricates a `dev:` id — proof no cloud call ran.
      expect(deployed.db.databaseId).toMatch(/^dev:/);

      const body = (yield* getJsonReady(
        `${deployed.worker.url}/roundtrip`,
      )) as {
        names: string[];
        count: number | null;
      };
      expect(body.names).toEqual(["alice", "bob"]);
      expect(body.count).toBe(2);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 120_000 },
);

/**
 * Migrations apply against the local simulator: reconcile boots an
 * ephemeral gateway workerd and drives the same migration flow the live
 * provider uses (Alchemy's `__alchemy_migrations` table, idempotent
 * re-application). Verified through the deployed worker's binding — the
 * same DO SQLite storage the gateway wrote to.
 */
test.provider(
  "D1 migrations apply against the local simulator and re-apply incrementally",
  (stack) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const migrationsDir = yield* fs.makeTempDirectory({
        prefix: "alchemy-d1-local-migrations-",
      });
      yield* fs.writeFileString(
        path.join(migrationsDir, "0001_users.sql"),
        [
          "CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT NOT NULL);",
          "INSERT INTO users (name) VALUES ('seed');",
        ].join("\n"),
      );

      yield* stack.destroy();

      const deploy = Effect.gen(function* () {
        const db = yield* Cloudflare.D1.Database("LocalMigratedDB", {
          migrations: migrationsDir,
        });
        const worker = yield* Cloudflare.Worker("d1-migrations-worker", {
          main: pathe.resolve(
            import.meta.dirname,
            "fixtures/d1-local-worker.ts",
          ),
          env: { DB: db },
        });
        return { db, worker };
      });

      const v1 = yield* stack.deploy(deploy);
      expect(v1.db.databaseId).toMatch(/^dev:/);
      expect(v1.db.migrationsTable).toBe("__alchemy_migrations");
      expect(Object.keys(v1.db.migrationsHashes)).toEqual(["0001_users.sql"]);

      const url = v1.worker.url!;
      const schema = (yield* getJsonReady(`${url}/tables`)) as {
        tables: string[];
      };
      expect(schema.tables).toContain("users");
      expect(schema.tables).toContain("__alchemy_migrations");

      const users = (yield* getJsonReady(`${url}/users`)) as {
        users: string[];
      };
      expect(users.users).toEqual(["seed"]);

      // Add a second migration — the redeploy applies ONLY the new file
      // (0001's seed row would fail a re-run with a duplicate table error,
      // so a passing redeploy also proves idempotency).
      yield* fs.writeFileString(
        path.join(migrationsDir, "0002_posts.sql"),
        "CREATE TABLE posts (id INTEGER PRIMARY KEY, title TEXT NOT NULL);",
      );

      const v2 = yield* stack.deploy(deploy);
      expect(v2.db.databaseId).toBe(v1.db.databaseId);
      expect(Object.keys(v2.db.migrationsHashes).sort()).toEqual([
        "0001_users.sql",
        "0002_posts.sql",
      ]);

      // Alchemy's shape: INTEGER ids, name-keyed.
      const migrations = (yield* getJsonReady(`${url}/migrations`)) as {
        migrations: Array<{ id: number; name: string }>;
      };
      expect(migrations.migrations).toEqual([
        { id: 1, name: "0001_users.sql" },
        { id: 2, name: "0002_posts.sql" },
      ]);

      // Data written by 0001 survived the second deploy (not re-applied).
      const usersAfter = (yield* getJsonReady(`${url}/users`)) as {
        users: string[];
      };
      expect(usersAfter.users).toEqual(["seed"]);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 120_000 },
);

/**
 * `importFiles` apply locally too: an import file is multi-statement SQL,
 * executed through the gateway with the same hash-skip semantics as the
 * cloud import flow. Verified through the worker's binding.
 */
test.provider(
  "D1 importFiles apply against the local simulator",
  (stack) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fs.makeTempDirectory({
        prefix: "alchemy-d1-local-import-",
      });
      const importFile = path.join(dir, "seed.sql");
      yield* fs.writeFileString(
        importFile,
        [
          "CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT NOT NULL);",
          "INSERT INTO users (name) VALUES ('imported');",
        ].join("\n"),
      );

      yield* stack.destroy();

      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          const db = yield* Cloudflare.D1.Database("LocalImportedDB", {
            importFiles: [importFile],
          });
          const worker = yield* Cloudflare.Worker("d1-import-worker", {
            main: pathe.resolve(
              import.meta.dirname,
              "fixtures/d1-local-worker.ts",
            ),
            env: { DB: db },
          });
          return { db, worker };
        }),
      );

      expect(deployed.db.databaseId).toMatch(/^dev:/);
      expect(Object.keys(deployed.db.importHashes)).toEqual([importFile]);

      const users = (yield* getJsonReady(`${deployed.worker.url}/users`)) as {
        users: string[];
      };
      expect(users.users).toEqual(["imported"]);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 120_000 },
);

/**
 * `QueryDatabaseLocal` (the stack-eval capability used in Actions) reaches
 * the LOCAL simulator when the database is a `dev:` row: queries tunnel
 * through an ephemeral workerd gateway into the same DO SQLite the worker
 * binding reads. The Action seeds; the deployed worker's native binding
 * observes the seeded rows — proving both transports share one database.
 */
test.provider(
  "QueryDatabaseLocal Action seeds the local simulator in dev",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          const db = yield* Cloudflare.D1.Database("ActionSeededDB");

          const Seed = Action(
            "Seed",
            Effect.gen(function* () {
              const client = yield* Cloudflare.D1.QueryDatabase(db);
              return Effect.fn(function* () {
                yield* client.exec(
                  "CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY, name TEXT NOT NULL)",
                );
                yield* client.prepare("DELETE FROM users").run();
                yield* client
                  .prepare("INSERT INTO users (name) VALUES (?)")
                  .bind("ada")
                  .run();
                const rows = yield* client
                  .prepare("SELECT name FROM users ORDER BY name")
                  .all<{ name: string }>();
                return { names: rows.results.map((r) => r.name) };
              });
            }).pipe(Effect.provide(Cloudflare.D1.QueryDatabaseLocal)),
          );
          const seeded = yield* Seed({});

          const worker = yield* Cloudflare.Worker("d1-action-worker", {
            main: pathe.resolve(
              import.meta.dirname,
              "fixtures/d1-local-worker.ts",
            ),
            env: { DB: db },
          });
          return { db, worker, seeded };
        }),
      );

      expect(deployed.db.databaseId).toMatch(/^dev:/);
      expect(deployed.seeded.names).toEqual(["ada"]);

      // The worker's native binding reads the same simulator storage the
      // Action's gateway wrote to.
      const users = (yield* getJsonReady(`${deployed.worker.url}/users`)) as {
        users: string[];
      };
      expect(users.users).toEqual(["ada"]);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 120_000 },
);

/**
 * `Alchemy.remote()` opts the database OUT of local emulation: even under
 * `alchemy dev` it is created on real Cloudflare (a real UUID, not a `dev:`
 * id) and the worker's `d1` binding proxies to it remotely. An out-of-band
 * query through the cloud API proves the worker's writes landed in the real
 * database, and destroy removes it.
 */
test.provider(
  "Alchemy.remote() database runs live in dev",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          const db = yield* Cloudflare.D1.Database("LiveDevDB").pipe(
            Alchemy.remote(),
          );
          const worker = yield* Cloudflare.Worker("d1-live-worker", {
            main: pathe.resolve(
              import.meta.dirname,
              "fixtures/d1-local-worker.ts",
            ),
            env: { DB: db },
          });
          return { db, worker };
        }),
      );

      // A real UUID — the live provider created it on Cloudflare.
      expect(deployed.db.databaseId).not.toMatch(/^dev:/);

      const body = (yield* getJsonReady(
        `${deployed.worker.url}/roundtrip`,
      )) as {
        names: string[];
      };
      expect(body.names).toEqual(["alice", "bob"]);

      // Out-of-band: the rows are visible through the cloud API — the
      // remote-proxied binding really hit the live database.
      const { accountId } = yield* yield* CloudflareEnvironment;
      const queryDb = yield* d1.queryDatabase;
      const result = yield* queryDb({
        accountId,
        databaseId: deployed.db.databaseId,
        sql: "SELECT name FROM users ORDER BY name;",
      });
      const names = (result.result[0]?.results ?? []) as Array<{
        name: string;
      }>;
      expect(names.map((r) => r.name)).toEqual(["alice", "bob"]);

      yield* stack.destroy();

      // Destroy deleted the real database (stamped live mode).
      const gone = yield* d1
        .getDatabase({ accountId, databaseId: deployed.db.databaseId })
        .pipe(
          Effect.as(false),
          Effect.catchTag("DatabaseNotFound", () => Effect.succeed(true)),
        );
      expect(gone).toBe(true);
    }).pipe(logLevel),
  { timeout: 120_000 },
);

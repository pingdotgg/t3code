import { purePlugin } from "@/Bundle/PurePlugin.ts";
import type { DurableObjectState } from "@/Cloudflare/Workers/DurableObjectState.ts";
import {
  SqlMigrations,
  type SqlMigrationsInput,
} from "@/Cloudflare/Workers/SqlMigrations.ts";
import {
  SqlMigrationsRuntime,
  type SqlMigrationSnapshot,
} from "@/Cloudflare/Workers/SqlMigrationsRuntime.ts";
import { makeEffectVirtualEntry } from "@/Cloudflare/Workers/Sources/Rolldown.ts";
import { Worker } from "@/Cloudflare/Workers/Worker.ts";
import {
  makeWorkerRuntimeContext,
  type WorkerExport,
  type WorkerRuntimeContext,
} from "@/Cloudflare/Workers/WorkerRuntimeContext.ts";
import type { RuntimeContext } from "@/RuntimeContext.ts";
import {
  DrizzleV0LayoutError,
  MigrationError,
  type MigrationHistoryConflictError,
} from "@/SQL/Migrations/Format.ts";
import { readMigrationRecords } from "@/SQL/Migrations/Records.ts";
import { sha256 } from "@/Util/sha256.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, layer } from "alchemy-test";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import { ChildProcessSpawner } from "effect/process/ChildProcessSpawner";
import { nodePath, nodeSupportsDevMode } from "../../nodeProbe.ts";

type Assert<T extends true> = T;
type Application = ReturnType<
  Effect.Success<ReturnType<typeof SqlMigrations>>["apply"]
>;
type _RequiresRuntimeContext = Assert<
  RuntimeContext extends Effect.Services<Application> ? true : false
>;
type _RequiresDurableObjectState = Assert<
  DurableObjectState extends Effect.Services<Application> ? true : false
>;
type _NotConstructionOnly = Assert<
  Application extends Effect.Effect<
    void,
    MigrationError | MigrationHistoryConflictError,
    Effect.Services<ReturnType<typeof SqlMigrations>>
  >
    ? false
    : true
>;
type _RuntimeRequiredEvenWithState = Assert<
  Application extends Effect.Effect<
    void,
    MigrationError | MigrationHistoryConflictError,
    DurableObjectState
  >
    ? false
    : true
>;
type _SnapshotHasNoMethod = Assert<
  "apply" extends keyof SqlMigrationSnapshot ? false : true
>;

// Worker resolves its host through the resource's Self key.
const WorkerHost = Context.Service<Worker, WorkerRuntimeContext>(
  Worker.Self.key,
);

const writeMigrations = Effect.fn(function* (files: Record<string, string>) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const dir = yield* fs.makeTempDirectoryScoped({
    prefix: "alchemy-sql-migrations-unit-",
  });
  for (const [name, contents] of Object.entries(files)) {
    const file = path.join(dir, name);
    yield* fs.makeDirectory(path.dirname(file), { recursive: true });
    yield* fs.writeFileString(file, contents);
  }
  return dir;
});

const capture = Effect.fn(function* (input: SqlMigrationsInput) {
  const worker = makeWorkerRuntimeContext("sql-migrations-unit");
  const snapshot = yield* SqlMigrations(input).pipe(
    Effect.provideService(WorkerHost, worker),
  );
  const { default: _default, ...exports } = yield* worker.exports;
  const migrationExports: Record<string, WorkerExport> = exports;
  return { worker, snapshot, exports: migrationExports };
});

const generatedEntry = (exports: Record<string, WorkerExport>) =>
  makeEffectVirtualEntry(exports, {
    name: "sql-migrations-unit",
    stage: "test",
  })("./worker.ts");

layer(NodeServices.layer)("Cloudflare.SqlMigrations construction", (it) => {
  it.effect(
    "captures ordered flat files and their raw-content hashes",
    () =>
      Effect.gen(function* () {
        const first = "CREATE TABLE users (id INTEGER PRIMARY KEY);\n";
        const second = "CREATE TABLE posts (id INTEGER PRIMARY KEY);\n";
        const dir = yield* writeMigrations({
          "10_posts.sql": second,
          "2_users.sql": first,
          "ignored.txt": "not a migration",
        });
        const { worker, snapshot, exports } = yield* capture(dir);

        expect(snapshot._tag).toBe("Cloudflare.SqlMigrations");
        expect(snapshot.table).toBe("__alchemy_migrations");
        expect(snapshot.records).toEqual(yield* readMigrationRecords(dir));
        expect(snapshot.records.map((record) => record.name)).toEqual([
          "2_users.sql",
          "10_posts.sql",
        ]);
        expect(snapshot.records.map((record) => record.hash)).toEqual([
          yield* sha256(first),
          yield* sha256(second),
        ]);
        expect(snapshot.records.map((record) => record.sql)).toEqual([
          first,
          second,
        ]);
        expect(
          snapshot.records.map((record) => record.createdAtMillis),
        ).toEqual([undefined, undefined]);
        expect(typeof snapshot.apply).toBe("function");
        expect(Effect.isEffect(snapshot.apply())).toBe(true);
        expect(Object.values(exports)).toEqual([
          {
            kind: "sqlMigrations",
            snapshot: {
              _tag: snapshot._tag,
              table: snapshot.table,
              records: snapshot.records,
            },
          },
        ]);
        for (const exported of Object.values(exports)) {
          if (exported.kind === "sqlMigrations") {
            expect(exported.snapshot).not.toHaveProperty("apply");
            expect(exported.snapshot).not.toBe(snapshot);
          }
        }
        expect(worker.env).toEqual({});
      }).pipe(Effect.scoped),
    {
      tags: [
        "unit",
        "provider:cloudflare",
        "provider:cloudflare:worker",
        "local",
      ],
    },
  );

  it.effect(
    "captures modern directories with timestamps and a custom table",
    () =>
      Effect.gen(function* () {
        const first =
          "CREATE TABLE users (id INTEGER PRIMARY KEY);\n--> statement-breakpoint\nINSERT INTO users VALUES (1);\n";
        const second = "CREATE TABLE posts (id INTEGER PRIMARY KEY);\n";
        const dir = yield* writeMigrations({
          "20240102000000_posts/migration.sql": second,
          "20240101000000_users/migration.sql": first,
          "20240101000000_users/snapshot.json": "{}",
        });
        const { snapshot, exports, worker } = yield* capture({
          dir,
          table: "application_history",
        });

        expect(snapshot.table).toBe("application_history");
        expect(snapshot.records).toEqual(yield* readMigrationRecords(dir));
        expect(snapshot.records.map((record) => record.name)).toEqual([
          "20240101000000_users",
          "20240102000000_posts",
        ]);
        expect(
          snapshot.records.map((record) => record.createdAtMillis),
        ).toEqual([1704067200000, 1704153600000]);
        expect(snapshot.records.map((record) => record.hash)).toEqual([
          yield* sha256(first),
          yield* sha256(second),
        ]);
        expect(snapshot.records[0]!.statements).toEqual([
          "CREATE TABLE users (id INTEGER PRIMARY KEY);",
          "INSERT INTO users VALUES (1);",
        ]);
        expect(Object.values(exports)).toEqual([
          {
            kind: "sqlMigrations",
            snapshot: {
              _tag: snapshot._tag,
              table: snapshot.table,
              records: snapshot.records,
            },
          },
        ]);
        expect(worker.env).toEqual({});
      }).pipe(Effect.scoped),
    {
      tags: [
        "unit",
        "provider:cloudflare",
        "provider:cloudflare:worker",
        "local",
      ],
    },
  );

  it.effect(
    "reconstructs apply from the plain runtime snapshot without reading the directory",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* writeMigrations({
          "migrations/0001_users.sql":
            "CREATE TABLE users (id INTEGER PRIMARY KEY);",
        });
        const dir = path.join(root, "migrations");
        const input = { dir, table: "runtime_history" };
        const captured = yield* capture(input);
        const bundles: Record<string, SqlMigrationSnapshot> = {};
        for (const [key, exported] of Object.entries(captured.exports)) {
          if (exported.kind === "sqlMigrations") {
            expect(exported.snapshot).not.toHaveProperty("apply");
            bundles[key] = exported.snapshot;
          }
        }
        expect(Object.keys(bundles)).toHaveLength(1);
        yield* fs.remove(dir, { recursive: true });

        const reconstructed = yield* Effect.acquireUseRelease(
          Effect.sync(() => {
            const previous = globalThis.__ALCHEMY_RUNTIME__;
            globalThis.__ALCHEMY_RUNTIME__ = true;
            return previous;
          }),
          () =>
            SqlMigrations(input).pipe(
              Effect.provideService(SqlMigrationsRuntime, bundles),
              Effect.provideService(WorkerHost, captured.worker),
            ),
          (previous) =>
            Effect.sync(() => {
              globalThis.__ALCHEMY_RUNTIME__ = previous;
            }),
        );

        expect(reconstructed._tag).toBe(captured.snapshot._tag);
        expect(reconstructed.table).toBe(captured.snapshot.table);
        expect(reconstructed.records).toEqual(captured.snapshot.records);
        expect(typeof reconstructed.apply).toBe("function");
        expect(Effect.isEffect(reconstructed.apply())).toBe(true);
        expect(reconstructed.apply).not.toBe(captured.snapshot.apply);
        for (const snapshot of Object.values(bundles)) {
          expect(snapshot).not.toHaveProperty("apply");
        }
      }).pipe(Effect.scoped),
    {
      tags: [
        "unit",
        "provider:cloudflare",
        "provider:cloudflare:worker",
        "local",
      ],
      exclusive: true,
    },
  );

  it.effect(
    "fails construction for a missing directory before registering exports",
    () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const root = yield* writeMigrations({});
        const dir = path.join(root, "missing");
        const worker = makeWorkerRuntimeContext("missing-sql-migrations");
        const exit = yield* SqlMigrations(dir).pipe(
          Effect.provideService(WorkerHost, worker),
          Effect.exit,
        );

        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          const error = Cause.squash(exit.cause);
          expect(error).toBeInstanceOf(MigrationError);
          expect(error).toMatchObject({
            message: expect.stringContaining(dir),
          });
        }
        expect(Object.keys(yield* worker.exports)).toEqual(["default"]);
        expect(worker.env).toEqual({});
      }).pipe(Effect.scoped),
    {
      tags: [
        "unit",
        "provider:cloudflare",
        "provider:cloudflare:worker",
        "local",
      ],
    },
  );

  it.effect(
    "rejects legacy journals even when modern migration files exist",
    () =>
      Effect.gen(function* () {
        const dir = yield* writeMigrations({
          "meta/_journal.json": '{"version":"7","entries":[]}',
          "20240101000000_users/migration.sql":
            "CREATE TABLE users (id INTEGER);",
        });
        const worker = makeWorkerRuntimeContext("legacy-sql-migrations");
        const exit = yield* SqlMigrations(dir).pipe(
          Effect.provideService(WorkerHost, worker),
          Effect.exit,
        );

        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          const error = Cause.squash(exit.cause);
          expect(error).toBeInstanceOf(DrizzleV0LayoutError);
          expect(error).toMatchObject({
            dir,
            message: expect.stringContaining("drizzle-kit up"),
          });
        }
        expect(Object.keys(yield* worker.exports)).toEqual(["default"]);
      }).pipe(Effect.scoped),
    {
      tags: [
        "unit",
        "provider:cloudflare",
        "provider:cloudflare:worker",
        "local",
      ],
    },
  );

  it.effect(
    "embeds SQL larger than 5 KB without file imports or environment bindings",
    () =>
      Effect.gen(function* () {
        const sql = `CREATE TABLE messages (body TEXT);\n--> statement-breakpoint\nINSERT INTO messages VALUES ('${"large-payload-".repeat(600)}');\n`;
        expect(sql.length).toBeGreaterThan(5 * 1024);
        const dir = yield* writeMigrations({ "0001_messages.sql": sql });
        const { snapshot, exports, worker } = yield* capture({
          dir,
          table: "large_history",
        });
        const entry = generatedEntry(exports);
        const snapshots = Object.fromEntries(
          Object.entries(exports).map(([key]) => [key, snapshot]),
        );

        expect(snapshot.records[0]!.sql).toBe(sql);
        expect(entry).toContain(
          `withSqlMigrations(entrypoint, ${JSON.stringify(snapshots)})`,
        );
        expect(entry).toContain(JSON.stringify(sql));
        expect(entry).toContain(snapshot.records[0]!.hash);
        expect(entry).toContain('"table":"large_history"');
        expect(entry).not.toMatch(
          /\b(?:from\s*|import\s*(?:\(\s*)?)(["'])[^"']*\.sql(?:\?[^"']*)?\1/,
        );
        expect(entry).not.toContain("migrations.js");
        expect(entry).not.toMatch(/\benv\s*(?:\.|\[)/);
        expect(entry).not.toContain("process.env");
        expect(entry).not.toContain("Records.ts");
        expect(worker.env).toEqual({});
      }).pipe(Effect.scoped),
    {
      tags: [
        "unit",
        "provider:cloudflare",
        "provider:cloudflare:worker",
        "local",
      ],
    },
  );

  it.effect(
    "changes the generated entry when SQL changes under the same capture key",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const firstSql = "CREATE TABLE first_version (id INTEGER);\n";
        const secondSql = "CREATE TABLE second_version (id INTEGER);\n";
        const dir = yield* writeMigrations({ "0001_schema.sql": firstSql });
        const input = { dir, table: "stable_history" };
        const first = yield* capture(input);
        const firstEntry = generatedEntry(first.exports);
        yield* fs.writeFileString(path.join(dir, "0001_schema.sql"), secondSql);
        const second = yield* capture(input);
        const secondEntry = generatedEntry(second.exports);

        expect(Object.keys(second.exports)).toEqual(Object.keys(first.exports));
        expect(second.snapshot.records[0]!.name).toBe(
          first.snapshot.records[0]!.name,
        );
        expect(second.snapshot.records[0]!.hash).toBe(yield* sha256(secondSql));
        expect(second.snapshot.records[0]!.hash).not.toBe(
          first.snapshot.records[0]!.hash,
        );
        expect(secondEntry).not.toBe(firstEntry);
        expect(firstEntry).toContain(JSON.stringify(firstSql));
        expect(secondEntry).toContain(JSON.stringify(secondSql));
        expect(secondEntry).not.toContain(JSON.stringify(firstSql));
        expect(first.snapshot.records[0]!.sql).toBe(firstSql);
      }).pipe(Effect.scoped),
    {
      tags: [
        "unit",
        "provider:cloudflare",
        "provider:cloudflare:worker",
        "local",
      ],
    },
  );

  it.effect(
    "keeps deploy-time readers out of the emitted Durable Object migrator graph",
    () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const input = yield* path.fromFileUrl(
          new URL(
            "../../../src/Cloudflare/Workers/SqlMigrationsApply.ts",
            import.meta.url,
          ),
        );
        const { rolldown } = yield* Effect.promise(() => import("rolldown"));
        const graph = new Set<string>();
        const output = yield* Effect.acquireUseRelease(
          Effect.promise(() =>
            rolldown({
              input,
              platform: "neutral",
              external: [/^effect\//, /^node:/],
              plugins: [
                {
                  name: "sql-migrations-runtime-boundary",
                  moduleParsed(info) {
                    graph.add(info.id);
                    for (const id of [
                      ...info.importedIds,
                      ...info.dynamicallyImportedIds,
                    ]) {
                      graph.add(id);
                    }
                  },
                },
              ],
            }),
          ),
          (bundle) => Effect.promise(() => bundle.generate({ format: "esm" })),
          (bundle) => Effect.promise(() => bundle.close()),
        );
        const chunks = output.output.filter((item) => item.type === "chunk");
        const modules = [
          ...graph,
          ...chunks.flatMap((chunk) => Object.keys(chunk.modules)),
        ];
        const code = chunks.map((chunk) => chunk.code).join("\n");
        const imports = chunks.flatMap((chunk) => [
          ...chunk.imports,
          ...chunk.dynamicImports,
        ]);

        expect(chunks.flatMap((chunk) => chunk.exports)).toContain(
          "applySqlMigrations",
        );
        expect(
          modules.some((id) => id.endsWith("/SQL/Migrations/AlchemyFormat.ts")),
        ).toBe(true);
        expect(
          modules.some((id) => id.endsWith("/SQL/Migrations/Convert.ts")),
        ).toBe(true);
        expect(
          modules.some((id) => id.endsWith("/SQL/Migrations/Utils.ts")),
        ).toBe(true);
        const forbidden =
          /(?:SQL\/Migrations\/(?:Records|Registry|Detect)\.ts|SQL\/SqlFile\.ts|node:(?:crypto|fs)|effect\/(?:FileSystem|Path))/;
        expect(modules.filter((id) => forbidden.test(id))).toEqual([]);
        expect(imports.filter((id) => forbidden.test(id))).toEqual([]);
        expect(code).not.toContain("node:crypto");
        expect(code).not.toContain("readMigrationRecords");
      }),
    {
      tags: [
        "unit",
        "provider:cloudflare",
        "provider:cloudflare:worker",
        "local",
      ],
    },
  );

  it.effect(
    "emits the SqlMigrations factory and apply method without filesystem imports",
    () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const input = yield* path.fromFileUrl(
          new URL(
            "../../../src/Cloudflare/Workers/SqlMigrations.ts",
            import.meta.url,
          ),
        );
        const { rolldown } = yield* Effect.promise(() => import("rolldown"));
        const output = yield* Effect.acquireUseRelease(
          Effect.promise(() =>
            rolldown({
              input,
              platform: "neutral",
              external: (id) => !id.startsWith(".") && !path.isAbsolute(id),
              transform: {
                define: { "globalThis.__ALCHEMY_RUNTIME__": "true" },
              },
              plugins: [purePlugin()],
            }),
          ),
          (bundle) =>
            Effect.promise(() =>
              bundle.generate({ format: "esm", minify: "dce-only" }),
            ),
          (bundle) => Effect.promise(() => bundle.close()),
        );
        const chunks = output.output.filter((item) => item.type === "chunk");
        const modules = chunks.flatMap((chunk) =>
          Object.entries(chunk.modules)
            .filter(([, module]) => module.renderedLength > 0)
            .map(([id]) => id),
        );
        const imports = chunks.flatMap((chunk) => [
          ...chunk.imports,
          ...chunk.dynamicImports,
        ]);
        const code = chunks.map((chunk) => chunk.code).join("\n");

        expect(chunks.flatMap((chunk) => chunk.exports)).toContain(
          "SqlMigrations",
        );
        expect(
          modules.some((id) => id.endsWith("/Workers/SqlMigrations.ts")),
        ).toBe(true);
        expect(
          modules.some((id) => id.endsWith("/Workers/SqlMigrationsApply.ts")),
        ).toBe(true);
        const forbidden =
          /(?:SQL\/Migrations\/(?:Records|Registry|Detect)\.ts|SQL\/SqlFile\.ts|node:(?:crypto|fs)|effect\/(?:FileSystem|Path)|@effect\/platform-(?:node|bun))/;
        expect(modules.filter((id) => forbidden.test(id))).toEqual([]);
        expect(imports.filter((id) => forbidden.test(id))).toEqual([]);
        expect(code).not.toContain("readMigrationRecords");
        expect(code).not.toContain("node:fs");
        expect(code).not.toContain("node:crypto");
      }),
    {
      tags: [
        "unit",
        "provider:cloudflare",
        "provider:cloudflare:worker",
        "local",
      ],
    },
  );

  it.effect.skipIf(!nodeSupportsDevMode)(
    "imports a SqlMigrations Durable Object through Node's Oxc loader and captures SQL",
    () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const spawner = yield* ChildProcessSpawner;
        const sql =
          "CREATE TABLE node_loader_probe (id INTEGER PRIMARY KEY);\n";
        const root = yield* writeMigrations({
          "migrations/0001_probe.sql": sql,
        });
        const loader = yield* path.fromFileUrl(
          new URL("../../../bin/register-dev-mode.js", import.meta.url),
        );
        const fixture = yield* path.fromFileUrl(
          new URL(
            "./fixtures/sql-migrations-unit/node-import.ts",
            import.meta.url,
          ),
        );
        const handle = yield* spawner.spawn(
          ChildProcess.make(nodePath!, ["--import", loader, fixture], {
            cwd: root,
            env: { NO_COLOR: "1", npm_execpath: "", npm_config_user_agent: "" },
            extendEnv: true,
            stdin: "ignore",
            stdout: "pipe",
            stderr: "pipe",
            killSignal: "SIGKILL",
          }),
        );
        const [stdout, stderr, exitCode] = yield* Effect.all(
          [
            handle.stdout.pipe(
              Stream.decodeText,
              Stream.runCollect,
              Effect.map((chunks) => chunks.join("")),
            ),
            handle.stderr.pipe(
              Stream.decodeText,
              Stream.runCollect,
              Effect.map((chunks) => chunks.join("")),
            ),
            handle.exitCode,
          ],
          { concurrency: 3 },
        );

        expect(stderr).toBe("");
        expect(exitCode).toBe(0);
        expect(stdout).toContain('"runtime":"node"');
        expect(stdout).toContain('"object":"SqlMigrationsUnitObject"');
        expect(stdout).toContain('"table":"node_loader_history"');
        expect(stdout).toContain(JSON.stringify(sql));
        expect(stdout).toContain(yield* sha256(sql));
        expect(stdout).toContain('"capturedHasApply":true');
        expect(stdout).toContain('"exportedHasApply":false');
        expect(stdout).toContain('"exports":1');
        expect(stdout).toContain('"env":{}');
      }).pipe(Effect.scoped),
    {
      tags: [
        "unit",
        "provider:cloudflare",
        "provider:cloudflare:worker",
        "local",
      ],
      timeout: 60_000,
    },
  );
});

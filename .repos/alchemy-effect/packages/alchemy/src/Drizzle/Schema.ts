import * as crypto from "node:crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { isResolved } from "../Diff.ts";
import * as Provider from "../Provider.ts";
import { Resource } from "../Resource.ts";
import type { Providers } from "./Providers.ts";

export type Dialect = "postgres" | "mysql" | "sqlite";

export type SchemaProps = {
  /**
   * Path to the schema module, relative to the current working directory.
   * The module is loaded via dynamic `import()` so drizzle-kit can introspect
   * the table definitions, then diffed against the latest snapshot under
   * `out` to detect changes.
   *
   * @example "./src/schema.ts"
   */
  schema: string;
  /**
   * Output directory for generated migrations. Each migration is written as
   * `{out}/{timestamp}_migration/{migration.sql, snapshot.json}`. Pass this
   * value through to `Neon.Branch`/`Cloudflare.D1Database` as `migrationsDir`
   * to apply pending migrations on deploy.
   *
   * @default "./migrations"
   */
  out?: string;
  /**
   * SQL dialect to generate migrations for. Selects which `drizzle-kit/api-*`
   * module is loaded.
   *
   * @default "postgres"
   */
  dialect?: Dialect;
};

export type Schema = Resource<
  "Drizzle.Schema",
  SchemaProps,
  {
    /** Absolute path to the migrations directory. */
    out: string;
    /**
     * sha256 of the latest snapshot.json. Stable across deploys when the
     * schema is unchanged; bumps trigger an update which regenerates pending
     * migration SQL. Downstream `migrationsDir` consumers read this to
     * detect drift and reapply.
     */
    snapshotHash: string;
    /** Names of all migration directories under `out`, in order. */
    migrations: string[];
  },
  never,
  Providers
>;

/**
 * A Drizzle schema managed as an Alchemy resource.
 *
 * Wraps drizzle-kit's programmatic API (`generateDrizzleJson` /
 * `generateMigration`) so migration SQL is regenerated as part of `alchemy
 * deploy` whenever the source schema changes. The output directory is
 * intended to be passed straight to a database resource's `migrationsDir`,
 * giving you a single deploy-driven flow:
 *
 * ```typescript
 * const schema = yield* Drizzle.Schema("app-schema", {
 *   schema: "./src/schema.ts",
 * });
 *
 * const branch = yield* Neon.Branch("app-branch", {
 *   project,
 *   migrationsDir: schema.out,
 * });
 * ```
 *
 * `Drizzle.Schema` runs first (because `Neon.Branch` depends on its `out`
 * output), regenerates pending migration files, and `Neon.Branch` then
 * applies them transactionally.
 *
 * The resource is delete-safe: removing it from the stack does **not** wipe
 * the migrations directory, since migration files are typically checked in
 * and shared with other environments.
 */
export const Schema = Resource<Schema>("Drizzle.Schema");

const dialectModule = (dialect: Dialect): string => {
  switch (dialect) {
    case "postgres":
      return "drizzle-kit/api-postgres";
    case "mysql":
      return "drizzle-kit/api-mysql";
    case "sqlite":
      return "drizzle-kit/api-sqlite";
  }
};

const sha = (s: string) => crypto.createHash("sha256").update(s).digest("hex");

const tsStamp = () =>
  new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);

export const SchemaProvider = () =>
  Provider.effect(
    Schema,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;

      const resolveOut = (p: SchemaProps) =>
        path.resolve(process.cwd(), p.out ?? "./migrations");

      const resolveSchema = (p: SchemaProps) =>
        path.resolve(process.cwd(), p.schema);

      const loadSchemaModule = (p: SchemaProps) =>
        Effect.tryPromise({
          try: () =>
            import(/* @vite-ignore */ resolveSchema(p)) as Promise<
              Record<string, unknown>
            >,
          catch: (cause) =>
            new Error(`Failed to import schema at ${p.schema}: ${cause}`),
        });

      const loadKit = (dialect: Dialect) =>
        Effect.tryPromise({
          try: () =>
            import(/* @vite-ignore */ dialectModule(dialect)) as Promise<{
              generateDrizzleJson: (
                imports: Record<string, unknown>,
                prevId?: string,
                schemaFilters?: string[],
              ) => Promise<unknown>;
              generateMigration: (
                prev: unknown,
                cur: unknown,
              ) => Promise<string[]>;
            }>,
          catch: (cause) =>
            new Error(
              `Failed to load drizzle-kit/${dialect} (is drizzle-kit installed?): ${cause}`,
            ),
        });

      // List `<ts>_*` migration directories under `out`, sorted by numeric
      // prefix. Returns an empty array if `out` doesn't exist.
      const listMigrationDirs = (out: string) =>
        Effect.gen(function* () {
          const exists = yield* fs.exists(out);
          if (!exists) return [] as string[];
          const entries = yield* fs.readDirectory(out);
          return entries.filter((name) => /^\d+_/.test(name)).sort();
        });

      const readLatestSnapshot = (out: string) =>
        Effect.gen(function* () {
          const dirs = yield* listMigrationDirs(out);
          for (const dir of [...dirs].reverse()) {
            const snapshotPath = path.join(out, dir, "snapshot.json");
            const exists = yield* fs.exists(snapshotPath);
            if (!exists) continue;
            const text = yield* fs.readFileString(snapshotPath);
            return { snapshot: JSON.parse(text) as unknown, hash: sha(text) };
          }
          return undefined;
        });

      /**
       * Run drizzle-kit's diff against the latest stored snapshot and
       * return whether any SQL statements would be emitted. Used by both
       * `diff` (to decide whether the resource actually needs an update)
       * and `regenerate` (to decide whether to write a new migration dir).
       */
      const detectDrift = (props: SchemaProps) =>
        Effect.gen(function* () {
          const out = resolveOut(props);
          const dialect = props.dialect ?? "postgres";
          const kit = yield* loadKit(dialect);
          const schemaModule = yield* loadSchemaModule(props);
          const cur = yield* Effect.tryPromise({
            try: () => kit.generateDrizzleJson(schemaModule),
            catch: (cause) =>
              new Error(`drizzle-kit generateDrizzleJson failed: ${cause}`),
          });

          const prevEntry = yield* readLatestSnapshot(out);
          // For the initial migration, drizzle-kit needs an *empty* snapshot
          // produced by `generateDrizzleJson({})`, not a bare `{}` — the
          // snapshot has internal fields (`ddl`, etc.) that the differ reads.
          const prev =
            prevEntry?.snapshot ??
            (yield* Effect.tryPromise({
              try: () => kit.generateDrizzleJson({}),
              catch: (cause) =>
                new Error(
                  `drizzle-kit generateDrizzleJson (empty baseline) failed: ${cause}`,
                ),
            }));
          const sqlStatements = yield* Effect.tryPromise({
            try: () => kit.generateMigration(prev, cur),
            catch: (cause) =>
              new Error(`drizzle-kit generateMigration failed: ${cause}`),
          });
          return { out, cur, prevEntry, sqlStatements };
        });

      /**
       * Generate a new migration directory if the schema has drifted from
       * the latest snapshot. Returns the new state regardless.
       */
      const regenerate = (props: SchemaProps) =>
        Effect.gen(function* () {
          const { out, cur, sqlStatements } = yield* detectDrift(props);

          if (sqlStatements.length > 0) {
            yield* fs.makeDirectory(out, { recursive: true });
            const dirName = `${tsStamp()}_migration`;
            const dirPath = path.join(out, dirName);
            yield* fs.makeDirectory(dirPath, { recursive: true });
            const sql =
              sqlStatements.join("\n--> statement-breakpoint\n") + "\n";
            yield* fs.writeFileString(path.join(dirPath, "migration.sql"), sql);
            yield* fs.writeFileString(
              path.join(dirPath, "snapshot.json"),
              JSON.stringify(cur, null, 2),
            );
          }

          const migrations = yield* listMigrationDirs(out);
          const latest = yield* readLatestSnapshot(out);
          return {
            out,
            snapshotHash: latest?.hash ?? sha(JSON.stringify(cur)),
            migrations,
          };
        });

      return {
        diff: Effect.fn(function* ({ news, output }) {
          if (!isResolved(news)) return undefined;
          if (!output) return undefined;
          // Only flag an update when drizzle-kit would emit new SQL —
          // otherwise downstream resources (e.g. Neon.Branch) would see
          // `schema.out` as an unresolved Output during plan and cascade
          // into spurious updates of their own.
          const { sqlStatements } = yield* detectDrift(news);
          if (sqlStatements.length === 0) return undefined;
          return { action: "update" } as const;
        }),
        read: Effect.fn(function* ({ olds, output }) {
          if (!output) return undefined;
          const out = resolveOut(olds ?? ({} as SchemaProps));
          const exists = yield* fs.exists(out);
          if (!exists) return undefined;
          const latest = yield* readLatestSnapshot(out);
          const migrations = yield* listMigrationDirs(out);
          return {
            out,
            snapshotHash: latest?.hash ?? output.snapshotHash,
            migrations,
          };
        }),
        reconcile: Effect.fn(function* ({ news, output, session }) {
          yield* session.note(
            `${output ? "Regenerating" : "Generating"} drizzle migrations for ${news.schema}`,
          );
          return yield* regenerate(news);
        }),
        delete: Effect.fn(function* () {
          // Migrations are typically checked in; do not delete on resource
          // teardown.
        }),
      };
    }),
  );

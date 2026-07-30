import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import type { PlatformError } from "effect/PlatformError";
import { ChildProcess } from "effect/unstable/process";
import * as crypto from "node:crypto";
import * as Artifacts from "../Artifacts.ts";
import { isResolved } from "../Diff.ts";
import * as Provider from "../Provider.ts";
import { Resource } from "../Resource.ts";
import { exec } from "../Util/exec.ts";
import type { Providers } from "./Providers.ts";

export type Dialect = "postgres" | "mysql" | "sqlite";

type DrizzleSnapshot = {
  id?: string;
  prevIds?: string[];
};

type DrizzleKitApi = {
  generateDrizzleJson?: (
    imports: Record<string, unknown>,
    prevId?: string,
    schemaFilters?: string[],
  ) => Promise<unknown>;
  generateMigration?: (prev: unknown, cur: unknown) => Promise<string[]>;
};

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
   * value through to `Neon.Branch`/`Cloudflare.D1.Database` as `migrationsDir`
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
    /** Path to the migrations directory, relative to the current working directory. */
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
 * @resource
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

      // The `out` attribute is exposed as a path relative to the current
      // working directory so that persisted state stays portable across
      // machines/checkouts. Internal filesystem ops always use the absolute
      // `resolveOut` form.
      const relativeOut = (abs: string) => path.relative(process.cwd(), abs);

      const resolveSchema = (p: SchemaProps) =>
        path.resolve(process.cwd(), p.schema);

      const loadSchemaModule = (p: SchemaProps) =>
        Effect.gen(function* () {
          const schemaPath = resolveSchema(p);
          return yield* Effect.tryPromise({
            try: () =>
              import(/* @vite-ignore */ schemaPath) as Promise<
                Record<string, unknown>
              >,
            catch: (cause) =>
              new Error(`Failed to import schema at ${p.schema}: ${cause}`),
          });
        });

      const loadKit = (dialect: Dialect) =>
        Effect.tryPromise({
          try: () =>
            import(
              /* @vite-ignore */ dialectModule(dialect)
            ) as Promise<DrizzleKitApi>,
          catch: (cause) =>
            new Error(
              `Failed to load drizzle-kit/${dialect} (is drizzle-kit installed?): ${cause}`,
            ),
        });

      const drizzleKitBin = (dialect: Dialect) =>
        Effect.gen(function* () {
          const apiUrl = yield* Effect.try({
            try: () => import.meta.resolve(dialectModule(dialect)),
            catch: (cause) =>
              new Error(`Failed to resolve drizzle-kit/${dialect}: ${cause}`),
          });
          const apiFileUrl = yield* Effect.try({
            try: () => new URL(apiUrl),
            catch: (cause) =>
              new Error(`Failed to parse drizzle-kit/${dialect} URL: ${cause}`),
          });
          const apiPath = yield* path.fromFileUrl(apiFileUrl);
          return path.join(path.dirname(apiPath), "bin.cjs");
        });

      const runDrizzleGenerate = (props: SchemaProps, out: string) =>
        Effect.gen(function* () {
          const dialect = props.dialect ?? "postgres";
          const bin = yield* drizzleKitBin(dialect);
          const schemaPath = resolveSchema(props);
          const nodeExecPath = yield* Effect.sync(() => process.execPath);
          const nodeModulesPath = path.join(process.cwd(), "node_modules");

          // drizzle-kit globs the --schema/--out values; Windows backslashes
          // are treated as glob escapes and match nothing, so pass forward
          // slashes.
          const args = [
            bin,
            "generate",
            "--dialect",
            dialect === "postgres" ? "postgresql" : dialect,
            "--schema",
            schemaPath.replaceAll("\\", "/"),
            "--out",
            out.replaceAll("\\", "/"),
          ];

          const commandOptions = {
            cwd: process.cwd(),
            env: { NODE_PATH: nodeModulesPath },
            extendEnv: true,
          };

          const interactive =
            !process.env.CI &&
            process.stdin.isTTY &&
            process.stdout.isTTY &&
            process.stderr.isTTY;

          if (interactive) {
            const handle = yield* ChildProcess.make(nodeExecPath, args, {
              ...commandOptions,
              stdin: "inherit",
              stdout: "inherit",
              stderr: "inherit",
            }).pipe(
              Effect.mapError(
                (cause) =>
                  new Error(`drizzle-kit generate failed: ${String(cause)}`),
              ),
            );
            const exitCode = yield* handle.exitCode;
            if (exitCode !== 0) {
              return yield* Effect.fail(
                new Error(`drizzle-kit generate failed with exit ${exitCode}`),
              );
            }
            return;
          }

          const result = yield* exec(
            ChildProcess.make(nodeExecPath, args, commandOptions),
          ).pipe(
            Effect.mapError(
              (cause) =>
                new Error(`drizzle-kit generate failed: ${String(cause)}`),
            ),
          );
          if (result.exitCode === 0) return;

          // Since drizzle-kit 1.0.0-rc.4 the non-interactive CLI refuses
          // ambiguous decisions (rename-vs-create, data-loss confirmation)
          // with a `missing_hints` report on exit 2. These are deliberate
          // safety prompts — the generated SQL is applied to the real
          // database later in the same deploy — so we never answer them
          // automatically. Ask the user to decide.
          if (result.exitCode === 2) {
            return yield* Effect.fail(
              new Error(
                [
                  `drizzle-kit needs a decision for ${props.schema} that cannot be made non-interactively (rename vs create, or a change that loses data):`,
                  "",
                  result.stdout.trim(),
                  "",
                  "To resolve, generate the migration yourself and commit it:",
                  `  npx drizzle-kit generate --dialect ${dialect === "postgres" ? "postgresql" : dialect} --schema ${props.schema} --out ${props.out ?? "./migrations"}`,
                  "then re-run the deploy (the schema resource will see no drift and apply the committed migration).",
                  "Alternatively, run the deploy in a terminal to answer drizzle-kit's prompts interactively.",
                ].join("\n"),
              ),
            );
          }

          return yield* Effect.fail(
            new Error(
              `drizzle-kit generate failed: ${result.stdout}\n${result.stderr}`,
            ),
          );
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

      // The latest snapshot is the head of the `prevIds` chain — the one no
      // other snapshot points back to. Directory-name order alone is not
      // enough: two migrations generated within the same second share the
      // timestamp prefix, and the random name suffix then decides the sort.
      const readLatestSnapshot = (out: string) =>
        Effect.gen(function* () {
          const dirs = yield* listMigrationDirs(out);
          const entries: Array<{ snapshot: DrizzleSnapshot; hash: string }> =
            [];
          for (const dir of dirs) {
            const snapshotPath = path.join(out, dir, "snapshot.json");
            const exists = yield* fs.exists(snapshotPath);
            if (!exists) continue;
            const text = yield* fs.readFileString(snapshotPath);
            entries.push({
              snapshot: JSON.parse(text) as DrizzleSnapshot,
              hash: sha(text),
            });
          }
          if (entries.length === 0) return undefined;
          const referenced = new Set(
            entries.flatMap((entry) => entry.snapshot.prevIds ?? []),
          );
          const head = entries.find(
            (entry) =>
              entry.snapshot.id !== undefined &&
              !referenced.has(entry.snapshot.id),
          );
          // Fall back to name order for snapshots without id/prevIds chains.
          return head ?? entries[entries.length - 1];
        });

      const detectDriftWithCli = (props: SchemaProps) =>
        Effect.gen(function* () {
          const out = resolveOut(props);
          const tmpOut = yield* fs.makeTempDirectory({
            prefix: "alchemy-drizzle-generate-",
          });

          return yield* Effect.gen(function* () {
            const outExists = yield* fs.exists(out);
            if (outExists) yield* copyDirectory(out, tmpOut);

            const before = yield* listMigrationDirs(tmpOut);
            yield* runDrizzleGenerate(props, tmpOut);

            const after = yield* listMigrationDirs(tmpOut);
            const latest = yield* readLatestSnapshot(tmpOut);
            const changed = after.some((dir) => !before.includes(dir));

            const prevEntry = outExists
              ? yield* readLatestSnapshot(out)
              : undefined;

            return {
              mode: "cli" as const,
              out,
              cur: latest?.snapshot,
              prevEntry,
              changed,
            };
          }).pipe(
            Effect.ensuring(
              fs.remove(tmpOut, { recursive: true }).pipe(Effect.ignore),
            ),
          );
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
          if (!kit.generateDrizzleJson || !kit.generateMigration) {
            return yield* detectDriftWithCli(props);
          }

          const generateDrizzleJson = kit.generateDrizzleJson;
          const generateMigration = kit.generateMigration;

          const schemaModule = yield* loadSchemaModule(props);
          const prevEntry = yield* readLatestSnapshot(out);
          const cur = yield* Effect.tryPromise({
            try: () =>
              generateDrizzleJson(schemaModule, prevEntry?.snapshot.id),
            catch: (cause) =>
              new Error(`drizzle-kit generateDrizzleJson failed: ${cause}`),
          });

          // For the initial migration, drizzle-kit needs an *empty* snapshot
          // produced by `generateDrizzleJson({})`, not a bare `{}` — the
          // snapshot has internal fields (`ddl`, etc.) that the differ reads.
          const prev =
            prevEntry?.snapshot ??
            (yield* Effect.tryPromise({
              try: () => generateDrizzleJson({}),
              catch: (cause) =>
                new Error(
                  `drizzle-kit generateDrizzleJson (empty baseline) failed: ${cause}`,
                ),
            }));
          const sqlStatements = yield* Effect.tryPromise({
            try: () => generateMigration(prev, cur),
            catch: (cause) =>
              new Error(`drizzle-kit generateMigration failed: ${cause}`),
          });
          return {
            mode: "programmatic" as const,
            out,
            cur,
            prevEntry,
            sqlStatements,
          };
        }).pipe(Artifacts.cached("detectDrift"));

      /**
       * Generate a new migration directory if the schema has drifted from
       * the latest snapshot. Returns the new state regardless.
       */
      const regenerate = (props: SchemaProps) =>
        Effect.gen(function* () {
          const drift = yield* detectDrift(props);

          if (drift.mode === "cli") {
            if (drift.changed) {
              yield* runDrizzleGenerate(props, drift.out);
            }

            const migrations = yield* listMigrationDirs(drift.out);
            const latest = yield* readLatestSnapshot(drift.out);
            const snapshotHash = latest?.hash ?? sha(JSON.stringify(drift.cur));
            return {
              out: relativeOut(drift.out),
              snapshotHash,
              migrations,
            };
          }

          const { out, cur, sqlStatements } = drift;

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
          const snapshotHash = latest?.hash ?? sha(JSON.stringify(cur));
          return {
            out: relativeOut(out),
            snapshotHash,
            migrations,
          };
        });

      return {
        // Non-listable: a Drizzle.Schema is a local build artifact (generated
        // migration SQL under `out`, a path supplied entirely by props with no
        // account/store to enumerate). There is no remote enumeration API, so
        // there is nothing to discover out-of-band.
        list: () => Effect.succeed([]),
        diff: Effect.fn(function* ({ news, output }) {
          if (!isResolved(news)) return undefined;
          if (!output) return undefined;
          // Only flag an update when drizzle-kit would emit new SQL —
          // otherwise downstream resources (e.g. Neon.Branch) would see
          // `schema.out` as an unresolved Output during plan and cascade
          // into spurious updates of their own.
          const drift = yield* detectDrift(news);
          const changed =
            drift.mode === "cli"
              ? drift.changed
              : drift.sqlStatements.length > 0;
          // Originally `output.out` was an absolute path, which is not portable.
          // So, we trigger an update to migrate existing resources to the
          // canonical (cwd-relative) form. This is safe because `regenerate`
          // is idempotent. Compare against the canonical form rather than
          // testing `isAbsolute`: on Windows a cross-drive `out` can never be
          // relativized, so its canonical form IS absolute and an isAbsolute
          // check would flag an update on every deploy.
          return changed || output.out !== relativeOut(resolveOut(news))
            ? { action: "update" }
            : undefined;
        }),
        read: Effect.fn(function* ({ olds, output }) {
          if (!output) return undefined;
          const out = resolveOut(olds ?? ({} as SchemaProps));
          const exists = yield* fs.exists(out);
          if (!exists) return undefined;
          const latest = yield* readLatestSnapshot(out);
          const migrations = yield* listMigrationDirs(out);
          return {
            out: relativeOut(out),
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

const copyDirectory = (
  from: string,
  to: string,
): Effect.Effect<void, PlatformError, Path.Path | FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const fs = yield* FileSystem.FileSystem;

    yield* fs.makeDirectory(to, { recursive: true });
    const entries = yield* fs.readDirectory(from);

    for (const entry of entries) {
      const source = path.join(from, entry);
      const target = path.join(to, entry);
      const stat = yield* fs.stat(source);
      if (stat.type === "Directory") {
        yield* copyDirectory(source, target);
      } else {
        const contents = yield* fs.readFile(source);
        yield* fs.writeFile(target, contents);
      }
    }
  });

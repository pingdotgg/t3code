import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import type * as Path from "effect/Path";
import { hashMigrations } from "../SqlFile.ts";
import { recordsEqual } from "../../Util/equal.ts";
import { ALCHEMY_DEFAULT_TABLE, applyAlchemyFormat } from "./AlchemyFormat.ts";
import { detectLayout } from "./Detect.ts";
import {
  MigrationError,
  type DrizzleV0LayoutError,
  type MigrationHistoryConflictError,
  type SqlExecutor,
} from "./Format.ts";
import { readDrizzleDirRecords, readFlatRecords } from "./Records.ts";

/**
 * The migrations input surface shared by every SQL database resource.
 * A plain string is a directory; the object form overrides the
 * applied-migrations table name. A `Drizzle.Schema` resource's attributes
 * satisfy the `{ out }` shape structurally, so `migrations: schema` works
 * without importing the Drizzle module.
 *
 * There is exactly ONE bookkeeping format — Alchemy's `__alchemy_migrations`
 * table. A database previously migrated with drizzle-kit, Prisma, or
 * wrangler is adopted by a one-way conversion: the foreign table's history
 * is copied into Alchemy's table once and the foreign table is left frozen
 * (never written, never dropped). From then on Alchemy's table is the only
 * bookkeeping.
 */
export type MigrationsInput =
  | string
  | {
      /** Directory containing the migration files. */
      dir: string;
      /** Override the applied-migrations table name. */
      table?: string;
    }
  | {
      /** A `Drizzle.Schema`-shaped resource output. */
      out: string;
    };

export interface NormalizedMigrationsInput {
  dir: string;
  table?: string;
}

export const normalizeMigrationsInput = (
  input: MigrationsInput,
): NormalizedMigrationsInput => {
  if (typeof input === "string") return { dir: input };
  if ("out" in input) return { dir: input.out };
  return input;
};

/**
 * Normalize a resource's `migrations` prop into the registry input shape.
 * Shared by every SQL database resource.
 */
export const migrationsInputOf = (props: {
  migrations?: MigrationsInput;
}): NormalizedMigrationsInput | undefined =>
  props.migrations ? normalizeMigrationsInput(props.migrations) : undefined;

/**
 * What prior state remembers about migrations — the bookkeeping table a
 * previous deploy used. Rows written by pre-registry Alchemy persisted
 * their table name (`d1_migrations`, `neon_migrations`, custom names), and
 * honoring it keeps them converging against the same table (upgraded in
 * place to the current column shape) instead of starting a new one.
 */
export interface StampedMigrationsState {
  table?: string | undefined;
}

export const stampedOf = (
  output: { migrationsTable: string | undefined } | undefined,
): StampedMigrationsState => ({ table: output?.migrationsTable });

export interface ResolvedMigrations {
  dir: string;
  table: string;
}

/**
 * Resolve where this deploy's bookkeeping lives. Precedence: explicit
 * `table` on the input, then the table persisted by a prior deploy, then
 * the default `__alchemy_migrations`.
 */
export const resolveMigrations = (options: {
  input: NormalizedMigrationsInput;
  stamped: StampedMigrationsState;
}): ResolvedMigrations => ({
  dir: options.input.dir,
  table: options.input.table ?? options.stamped.table ?? ALCHEMY_DEFAULT_TABLE,
});

/**
 * Apply pending migrations. The directory layout only selects how records
 * are read and keyed (drizzle-kit/Prisma dirs by directory name, flat dirs
 * by file path) — the bookkeeping is always Alchemy's table, converting
 * foreign or legacy history on first contact (see `AlchemyFormat.ts`).
 */
export const applyMigrations = (options: {
  resolved: ResolvedMigrations;
  executor: SqlExecutor;
}): Effect.Effect<
  void,
  MigrationError | MigrationHistoryConflictError | DrizzleV0LayoutError,
  FileSystem.FileSystem | Path.Path
> =>
  Effect.gen(function* () {
    const { resolved, executor } = options;
    const layout = yield* detectLayout(resolved.dir);
    const records =
      layout === "flat"
        ? yield* readFlatRecords(resolved.dir)
        : yield* readDrizzleDirRecords(resolved.dir);
    yield* applyAlchemyFormat({
      executor,
      table: resolved.table,
      records,
    });
  });

const hashMigrationsDir = (dir: string) =>
  hashMigrations(dir).pipe(
    Effect.mapError(
      (cause) =>
        new MigrationError({
          message: `Failed to read migrations from ${dir}: ${String(cause)}`,
          cause,
        }),
    ),
  );

/** The result of one migration sync, ready to stamp into attributes. */
export interface MigrationRun {
  resolved: ResolvedMigrations;
  hashes: Record<string, string>;
}

/**
 * The whole per-deploy migration pipeline: hash the directory (for state
 * drift tracking), resolve the bookkeeping table, and — when the directory
 * is non-empty — apply pending migrations. The database provider supplies
 * only `withExecutor`, a bracket that acquires its target's
 * {@link SqlExecutor} (a D1 HTTP handle, a pg client over a Neon URI or
 * PlanetScale temp role, a mysql2 connection) around the apply.
 */
export const runMigrations = <E, R>(options: {
  input: NormalizedMigrationsInput;
  stamped: StampedMigrationsState;
  withExecutor: (
    apply: (
      executor: SqlExecutor,
    ) => Effect.Effect<
      void,
      MigrationError | MigrationHistoryConflictError | DrizzleV0LayoutError,
      FileSystem.FileSystem | Path.Path
    >,
  ) => Effect.Effect<void, E, R>;
}): Effect.Effect<
  MigrationRun,
  MigrationError | E,
  R | FileSystem.FileSystem | Path.Path
> =>
  Effect.gen(function* () {
    const hashes = yield* hashMigrationsDir(options.input.dir);
    const resolved = resolveMigrations(options);
    if (Object.keys(hashes).length > 0) {
      yield* options.withExecutor((executor) =>
        applyMigrations({ resolved, executor }),
      );
    }
    return { resolved, hashes };
  });

/**
 * The shared migration half of a provider `diff`: true when pending file
 * changes or a bookkeeping-table move require an update. Callers decide the
 * action shape (`{ action: "update" }`, with or without stables).
 */
export const diffMigrations = (options: {
  news: { migrations?: MigrationsInput };
  output:
    | {
        migrationsTable: string | undefined;
        migrationsHashes: Record<string, string>;
      }
    | undefined;
}): Effect.Effect<boolean, MigrationError, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const input = migrationsInputOf(options.news);
    if (!input) return false;
    const newHashes = yield* hashMigrationsDir(input.dir);
    if (!recordsEqual(newHashes, options.output?.migrationsHashes ?? {})) {
      return true;
    }
    const resolved = resolveMigrations({
      input,
      stamped: stampedOf(options.output),
    });
    return (
      resolved.table !== (options.output?.migrationsTable ?? resolved.table)
    );
  });

/**
 * The migration attributes every SQL database resource persists, threaded
 * uniformly: the run's results when migrations ran, otherwise the prior
 * state (so removing `migrations` keeps the stamp and hashes for a later
 * re-add).
 */
export const migrationsAttrs = (options: {
  input: NormalizedMigrationsInput | undefined;
  run: MigrationRun | undefined;
  output:
    | {
        migrationsTable: string | undefined;
        migrationsHashes: Record<string, string>;
      }
    | undefined;
}): {
  migrationsDir: string | undefined;
  migrationsTable: string | undefined;
  migrationsHashes: Record<string, string>;
} => ({
  migrationsDir: options.input?.dir,
  migrationsTable:
    options.run?.resolved.table ?? options.output?.migrationsTable,
  migrationsHashes:
    options.run?.hashes ?? options.output?.migrationsHashes ?? {},
});

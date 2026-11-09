import { recordsEqual } from "alchemy/Util/equal";
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import type * as Path from "effect/Path";
import { hashMigrations } from "../SqlFile.ts";
import { ALCHEMY_DEFAULT_TABLE, applyAlchemyFormat } from "./AlchemyFormat.ts";
import {
  MigrationError,
  type DrizzleV0LayoutError,
  type MigrationApplyError,
  type SqlExecutor,
} from "./Format.ts";
import { readMigrationRecords } from "./Records.ts";

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

export const normalizeMigrationsInput = (input: MigrationsInput): NormalizedMigrationsInput => {
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
  MigrationApplyError | DrizzleV0LayoutError,
  FileSystem.FileSystem | Path.Path
> =>
  Effect.gen(function* () {
    const { resolved, executor } = options;
    const records = yield* readMigrationRecords(resolved.dir);
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
      MigrationApplyError | DrizzleV0LayoutError,
      FileSystem.FileSystem | Path.Path
    >,
  ) => Effect.Effect<void, E, R>;
}): Effect.Effect<MigrationRun, MigrationError | E, R | FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const hashes = yield* hashMigrationsDir(options.input.dir);
    const resolved = resolveMigrations(options);
    if (Object.keys(hashes).length > 0) {
      yield* options.withExecutor((executor) => applyMigrations({ resolved, executor }));
    }
    return { resolved, hashes };
  });

/**
 * Prior migration files whose contents changed or that disappeared from
 * the directory, relative to the hashes persisted on the last deploy.
 * Additive files (new names) are not rewritten history.
 */
export const rewrittenMigrationHistory = (
  previous: Record<string, string> | undefined,
  next: Record<string, string>,
): { changed: string[]; removed: string[] } | undefined => {
  if (previous === undefined) return undefined;
  const changed: string[] = [];
  const removed: string[] = [];
  for (const name of Object.keys(previous)) {
    const hash = next[name];
    if (hash === undefined) removed.push(name);
    else if (hash !== previous[name]) changed.push(name);
  }
  changed.sort();
  removed.sort();
  if (changed.length === 0 && removed.length === 0) return undefined;
  return { changed, removed };
};

export type MigrationHistoryChange =
  | { readonly kind: "none" }
  | { readonly kind: "pending" }
  | {
      readonly kind: "rewritten";
      readonly changed: ReadonlyArray<string>;
      readonly removed: ReadonlyArray<string>;
    };

/**
 * Classify the migration half of a provider `diff`:
 * - `none` — hashes and bookkeeping table are unchanged
 * - `pending` — new files and/or a table rename; apply in place
 * - `rewritten` — an already-applied file was edited or removed
 */
export const classifyMigrationHistory = (options: {
  news: { migrations?: MigrationsInput };
  output:
    | {
        migrationsTable: string | undefined;
        migrationsHashes: Record<string, string>;
      }
    | undefined;
}): Effect.Effect<MigrationHistoryChange, MigrationError, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const input = migrationsInputOf(options.news);
    if (!input) return { kind: "none" } as const;
    const newHashes = yield* hashMigrationsDir(input.dir);
    const rewritten = rewrittenMigrationHistory(options.output?.migrationsHashes, newHashes);
    if (rewritten) {
      return { kind: "rewritten", ...rewritten } as const;
    }
    if (!recordsEqual(newHashes, options.output?.migrationsHashes ?? {})) {
      return { kind: "pending" } as const;
    }
    const resolved = resolveMigrations({
      input,
      stamped: stampedOf(options.output),
    });
    return resolved.table !== (options.output?.migrationsTable ?? resolved.table)
      ? ({ kind: "pending" } as const)
      : ({ kind: "none" } as const);
  });

/**
 * The shared migration half of a provider `diff`: true when pending file
 * changes, rewritten history, or a bookkeeping-table move require an
 * action. Callers that can replace (PlanetScale development branches)
 * should consult {@link classifyMigrationHistory} instead of this boolean.
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
  classifyMigrationHistory(options).pipe(Effect.map((change) => change.kind !== "none"));

/** The attributes every SQL database resource with `migrations` exposes. */
export interface MigrationAttributes {
  /** Directory of the applied SQL migrations. */
  migrationsDir: string | undefined;
  /** Migration bookkeeping table. */
  migrationsTable: string | undefined;
  /** Applied migration content hashes. */
  migrationsHashes: Record<string, string>;
}

/**
 * Carry migration attributes from prior state (`read`, `list`), defaulting
 * to none recorded.
 */
export const migrationAttributesOf = (
  prior: Partial<MigrationAttributes> | undefined,
): MigrationAttributes => ({
  migrationsDir: prior?.migrationsDir,
  migrationsTable: prior?.migrationsTable,
  migrationsHashes: prior?.migrationsHashes ?? {},
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
}): MigrationAttributes => ({
  migrationsDir: options.input?.dir,
  migrationsTable: options.run?.resolved.table ?? options.output?.migrationsTable,
  migrationsHashes: options.run?.hashes ?? options.output?.migrationsHashes ?? {},
});

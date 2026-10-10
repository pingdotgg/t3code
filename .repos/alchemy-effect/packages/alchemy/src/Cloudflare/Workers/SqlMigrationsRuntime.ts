import * as Context from "effect/Context";
import * as Layer from "effect/Layer";
import { makeEntrypointLayer } from "../../Runtime.ts";
import { Self } from "../../Self.ts";
import type { MigrationRecord } from "../../SQL/Migrations/Format.ts";

/** SQL files captured during construction and embedded in the Worker bundle. */
export interface SqlMigrationSnapshot {
  readonly _tag: "Cloudflare.SqlMigrations";
  /** The per-instance applied-migrations table. */
  readonly table: string;
  /** Ordered SQL records, including their content hashes. */
  readonly records: ReadonlyArray<MigrationRecord>;
}

/** @internal */
export interface SqlMigrationsExport {
  readonly kind: "sqlMigrations";
  readonly snapshot: SqlMigrationSnapshot;
}

export class SqlMigrationsRuntime extends Context.Service<
  SqlMigrationsRuntime,
  Readonly<Record<string, SqlMigrationSnapshot>>
>()("Cloudflare.SqlMigrationsRuntime") {}

/** Supply the generated migration records to every entrypoint and object activation. */
export const withSqlMigrations = (
  entrypoint: unknown,
  migrations: Readonly<Record<string, SqlMigrationSnapshot>>,
) =>
  makeEntrypointLayer(Self, entrypoint).pipe(
    Layer.provideMerge(Layer.succeed(SqlMigrationsRuntime, migrations)),
  );

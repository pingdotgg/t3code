import * as Effect from "effect/Effect";
import type { RuntimeContext } from "../../RuntimeContext.ts";
import { applyAlchemyFormat } from "../../SQL/Migrations/AlchemyFormat.ts";
import {
  MigrationError,
  type MigrationHistoryConflictError,
  type SqlExecutor,
} from "../../SQL/Migrations/Format.ts";
import { inlineSqlParams } from "../../SQL/Migrations/Utils.ts";
import { DurableObjectState } from "./DurableObjectState.ts";
import type { SqlMigrationSnapshot } from "./SqlMigrationsRuntime.ts";

/** @internal */
export const applySqlMigrations: (
  migrations: SqlMigrationSnapshot,
) => Effect.Effect<
  void,
  MigrationError | MigrationHistoryConflictError,
  DurableObjectState | RuntimeContext
> = Effect.fn("Cloudflare.SqlMigrations.apply")(function* (migrations) {
  const { raw } = yield* DurableObjectState;
  const storage = raw.storage;
  const executor: SqlExecutor = {
    dialect: "sqlite",
    query: (sql, params = []) =>
      Effect.try({
        try: () =>
          storage.sql.exec(inlineSqlParams(sql, params, "sqlite")).toArray(),
        catch: (cause) =>
          new MigrationError({
            message: "Failed to query migration history",
            cause,
          }),
      }),
    batch: (statements) =>
      Effect.try({
        try: () =>
          storage.transactionSync(() => {
            for (const statement of statements) storage.sql.exec(statement);
          }),
        catch: (cause) =>
          new MigrationError({
            message: "Failed to apply SQL migration",
            cause,
          }),
      }),
  };
  yield* applyAlchemyFormat({
    executor,
    table: migrations.table,
    records: migrations.records,
  });
});

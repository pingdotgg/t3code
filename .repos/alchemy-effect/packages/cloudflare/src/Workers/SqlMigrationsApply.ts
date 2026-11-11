import { applyPendingAlchemyFormat } from "@alchemy.run/sql/Migrations/AlchemyFormat";
import {
  MigrationError,
  type MigrationHistoryConflictError,
  type SqlExecutor,
} from "@alchemy.run/sql/Migrations/Format";
import { inlineSqlParams } from "@alchemy.run/sql/Migrations/Utils";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import * as Effect from "effect/Effect";
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
        try: () => storage.sql.exec(inlineSqlParams(sql, params, "sqlite")).toArray(),
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
  yield* applyPendingAlchemyFormat({
    executor,
    table: migrations.table,
    records: migrations.records,
  });
});

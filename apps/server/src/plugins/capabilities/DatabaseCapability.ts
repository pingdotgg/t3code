import type { DatabaseCapability } from "@t3tools/plugin-sdk";
import type * as SqlClient from "effect/unstable/sql/SqlClient";

export function makeDatabaseCapability(sql: SqlClient.SqlClient): DatabaseCapability {
  return {
    client: sql,
    execute: (statement, params = []) =>
      sql.unsafe<Record<string, unknown>>(statement, params).unprepared,
    withTransaction: (effect) => sql.withTransaction(effect),
  };
}

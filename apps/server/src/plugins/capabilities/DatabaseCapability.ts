import type { DatabaseCapability } from "@t3tools/plugin-sdk";
import type * as SqlClient from "effect/unstable/sql/SqlClient";

// INTENTIONAL, by design under the full-trust-in-process model: a plugin granted
// the `database` capability already runs with full in-process trust, so exposing
// the raw `SqlClient` plus `sql.unsafe` grants it nothing beyond what `execute`
// already would. The `p_<id>_*` table prefix is a migration-time authoring
// convention, NOT a runtime sandbox — the façade deliberately does not police
// runtime statements, namespace tables, or enforce a read-only path. Do not
// "harden" this into a restricted client; that would break the ported plugin
// code this capability exists to run without adding any real isolation.
export function makeDatabaseCapability(sql: SqlClient.SqlClient): DatabaseCapability {
  return {
    client: sql,
    execute: (statement, params = []) =>
      sql.unsafe<Record<string, unknown>>(statement, params).unprepared,
    withTransaction: (effect) => sql.withTransaction(effect),
  };
}

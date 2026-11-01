import type * as spanner from "@distilled.cloud/gcp/spanner_v1";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { RuntimeContext } from "../../RuntimeContext.ts";
import type { Database } from "./Database.ts";

export interface ExecuteSqlRequest extends spanner.ExecuteSqlRequest {}

export type ExecuteSqlError =
  | spanner.CreateProjectsInstancesDatabasesSessionsError
  | spanner.ExecuteSqlProjectsInstancesDatabasesSessionsError;

/**
 * Runtime binding for Spanner `sessions.executeSql`.
 *
 * Bind this operation to a {@link Database} in a Function/Action init
 * phase. Provide {@link ExecuteSqlHttp}. Statements run on one
 * multiplexed session per database, created on first use and reused for
 * the life of the runtime instance.
 *
 * ### Executing SQL
 * **Example:** Run a query
 * ```typescript
 * const executeSql = yield* GCP.Spanner.ExecuteSql(database);
 * const result = yield* executeSql({ sql: "SELECT 1 AS n" });
 * ```
 *
 * @binding
 * @category Spanner
 */
export interface ExecuteSql extends Binding.Service<
  ExecuteSql,
  "GCP.Spanner.ExecuteSql",
  (
    database: Database,
  ) => Effect.Effect<
    (
      request: ExecuteSqlRequest,
    ) => Effect.Effect<spanner.ResultSet, ExecuteSqlError, RuntimeContext>
  >
> {}

export const ExecuteSql = Binding.Service<ExecuteSql>("GCP.Spanner.ExecuteSql");

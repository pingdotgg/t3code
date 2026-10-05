import type * as sqladmin from "@distilled.cloud/gcp/sqladmin_v1";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { RuntimeContext } from "../../RuntimeContext.ts";
import type { Instance } from "./Instance.ts";

export interface ExecuteSqlRequest extends Omit<
  sqladmin.ExecuteSqlInstancesRequest,
  "instance" | "project"
> {}

/**
 * Runtime binding for Cloud SQL `instances.executeSql`.
 *
 * Bind this operation to an {@link Instance} in a Function/Action init
 * phase. Provide {@link ExecuteSqlHttp}. The instance must allow the
 * Execute SQL API (`dataApiAccess: true`).
 *
 * Grants `roles/cloudsql.instanceUser` (`cloudsql.instances.executeSql`,
 * `get`, `login`) on the project under an IAM Condition naming only this
 * instance.
 *
 * ### Executing SQL
 * **Example:** Run a statement
 * ```typescript
 * const executeSql = yield* GCP.SQL.ExecuteSql(db);
 * const result = yield* executeSql({
 *   body: {
 *     sqlStatement: "SELECT 1",
 *     database: "mysql",
 *     user: "root",
 *   },
 * });
 * ```
 *
 * @binding
 * @category SQL
 */
export interface ExecuteSql extends Binding.Service<
  ExecuteSql,
  "GCP.SQL.ExecuteSql",
  (
    instance: Instance,
  ) => Effect.Effect<
    (
      request: ExecuteSqlRequest,
    ) => Effect.Effect<
      sqladmin.SqlInstancesExecuteSqlResponse,
      sqladmin.ExecuteSqlInstancesError,
      RuntimeContext
    >
  >
> {}

export const ExecuteSql = Binding.Service<ExecuteSql>("GCP.SQL.ExecuteSql");

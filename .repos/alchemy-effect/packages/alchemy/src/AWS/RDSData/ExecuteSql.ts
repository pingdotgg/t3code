import * as rdsdata from "@distilled.cloud/aws/rds-data";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { RuntimeContext } from "../../RuntimeContext.ts";
import type { DBCluster } from "../RDS/DBCluster.ts";
import type { Secret } from "../SecretsManager/Secret.ts";

export interface ExecuteSqlOptions {
  secret: Secret;
  database?: string;
  schema?: string;
}

export interface ExecuteSqlRequest extends Omit<
  rdsdata.ExecuteSqlRequest,
  "dbClusterOrInstanceArn" | "awsSecretStoreArn" | "database" | "schema"
> {}

/**
 * Runtime binding for the deprecated `rds-data:ExecuteSql` API (Aurora
 * Serverless v1 era). Prefer `AWS.RDSData.ExecuteStatement`, which supports
 * named parameters and transactions.
 *
 * Bind it to a Data-API-enabled `DBCluster` and its credentials secret;
 * provide the implementation with `Effect.provide(AWS.RDSData.ExecuteSqlHttp)`.
 * @binding
 * @section Legacy SQL Execution
 * @example Run Raw SQL Statements
 * ```typescript
 * // init
 * const executeSql = yield* AWS.RDSData.ExecuteSql(db.cluster, {
 *   secret: db.secret,
 *   database: "app",
 * });
 *
 * // runtime — statements are passed as a single string, no parameters
 * const result = yield* executeSql({ sqlStatements: "SELECT 1" });
 * ```
 */
export interface ExecuteSql extends Binding.Service<
  ExecuteSql,
  "AWS.RDSData.ExecuteSql",
  (
    cluster: DBCluster,
    options: ExecuteSqlOptions,
  ) => Effect.Effect<
    (
      request: ExecuteSqlRequest,
    ) => Effect.Effect<
      rdsdata.ExecuteSqlResponse,
      rdsdata.ExecuteSqlError,
      RuntimeContext
    >
  >
> {}

export const ExecuteSql = Binding.Service<ExecuteSql>("AWS.RDSData.ExecuteSql");

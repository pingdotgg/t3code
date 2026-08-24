import * as rdsdata from "@distilled.cloud/aws/rds-data";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { RuntimeContext } from "../../RuntimeContext.ts";
import type { DBCluster } from "../RDS/DBCluster.ts";
import type { Secret } from "../SecretsManager/Secret.ts";

export interface ExecuteStatementOptions {
  secret: Secret;
  database?: string;
  schema?: string;
}

export interface ExecuteStatementRequest extends Omit<
  rdsdata.ExecuteStatementRequest,
  "resourceArn" | "secretArn" | "database" | "schema"
> {}

/**
 * Runtime binding for `rds-data:ExecuteStatement` — run a SQL statement
 * against an Aurora cluster over the HTTP Data API (no VPC attachment or
 * database socket required).
 *
 * Bind it to a `DBCluster` (with the Data API enabled via
 * `enableHttpEndpoint: true`) and the Secrets Manager secret holding the
 * database credentials. The cluster ARN, secret ARN, and database name are
 * injected automatically, and the function is granted
 * `rds-data:ExecuteStatement` plus `secretsmanager:GetSecretValue` on the
 * secret. Provide the implementation with
 * `Effect.provide(AWS.RDSData.ExecuteStatementHttp)`.
 * @binding
 * @section Executing Statements
 * @example Query with Named Parameters
 * ```typescript
 * export default MyFunction.make(
 *   { main: import.meta.url, url: true },
 *   Effect.gen(function* () {
 *     const db = yield* AWS.RDS.Aurora("AppDb", {
 *       subnetIds: [subnetA.subnetId, subnetB.subnetId],
 *       securityGroupIds: [dbSecurityGroup.groupId],
 *     });
 *     // init — bind the operation to the cluster + admin secret
 *     const executeStatement = yield* AWS.RDSData.ExecuteStatement(db.cluster, {
 *       secret: db.secret,
 *       database: "app",
 *     });
 *
 *     return {
 *       fetch: Effect.gen(function* () {
 *         // runtime — parameterized SQL over the Data API
 *         const result = yield* executeStatement({
 *           sql: "SELECT id, title FROM todos WHERE id = :id",
 *           parameters: [{ name: "id", value: { longValue: 1 } }],
 *         });
 *         return yield* HttpServerResponse.json({ records: result.records ?? [] });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(AWS.RDSData.ExecuteStatementHttp)),
 * );
 * ```
 *
 * @example Write Inside a Transaction
 * ```typescript
 * // pass a transactionId from AWS.RDSData.BeginTransaction to make the
 * // statement part of that transaction
 * yield* executeStatement({
 *   sql: "INSERT INTO todos (id, title) VALUES (:id, :title)",
 *   parameters: [
 *     { name: "id", value: { longValue: 42 } },
 *     { name: "title", value: { stringValue: "ship it" } },
 *   ],
 *   transactionId: tx.transactionId,
 * });
 * ```
 */
export interface ExecuteStatement extends Binding.Service<
  ExecuteStatement,
  "AWS.RDSData.ExecuteStatement",
  (
    cluster: DBCluster,
    options: ExecuteStatementOptions,
  ) => Effect.Effect<
    (
      request: ExecuteStatementRequest,
    ) => Effect.Effect<
      rdsdata.ExecuteStatementResponse,
      rdsdata.ExecuteStatementError,
      RuntimeContext
    >
  >
> {}

export const ExecuteStatement = Binding.Service<ExecuteStatement>(
  "AWS.RDSData.ExecuteStatement",
);

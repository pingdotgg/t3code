import type * as dms from "@distilled.cloud/aws/database-migration-service";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `dms:ReloadTables`.
 *
 * Bind this operation (account-level) to re-run the full load for specific
 * tables of a running replication task — the standard remediation when
 * {@link DescribeTableStatistics} reports table errors or validation
 * failures. Provide the implementation with
 * `Effect.provide(AWS.DMS.ReloadTablesHttp)`.
 * @binding
 * @section Monitoring Migration Progress
 * @example Reload a Failed Table
 * ```typescript
 * // init — account-level, no target resource
 * const reloadTables = yield* AWS.DMS.ReloadTables();
 *
 * // runtime
 * yield* reloadTables({
 *   ReplicationTaskArn: taskArn,
 *   TablesToReload: [{ SchemaName: "public", TableName: "orders" }],
 * });
 * ```
 */
export interface ReloadTables extends Binding.Service<
  ReloadTables,
  "AWS.DMS.ReloadTables",
  () => Effect.Effect<
    (
      request: dms.ReloadTablesMessage,
    ) => Effect.Effect<dms.ReloadTablesResponse, dms.ReloadTablesError>
  >
> {}

export const ReloadTables = Binding.Service<ReloadTables>(
  "AWS.DMS.ReloadTables",
);

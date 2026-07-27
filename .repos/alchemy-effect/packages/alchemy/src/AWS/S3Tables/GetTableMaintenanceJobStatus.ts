import type * as s3tables from "@distilled.cloud/aws/s3tables";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Table } from "./Table.ts";

/**
 * Runtime binding for the `GetTableMaintenanceJobStatus` operation (IAM
 * action `s3tables:GetTableMaintenanceJobStatus` on the table ARN).
 *
 * Reads the status of the bound {@link Table}'s managed maintenance jobs —
 * Iceberg compaction and snapshot management — including when each job last
 * ran and whether it succeeded. Useful for compute that monitors table
 * health at runtime. Provide the implementation with
 * `Effect.provide(AWS.S3Tables.GetTableMaintenanceJobStatusHttp)`.
 * @binding
 * @section Monitoring Maintenance
 * @example Inspect maintenance job statuses
 * ```typescript
 * const getTableMaintenanceJobStatus =
 *   yield* AWS.S3Tables.GetTableMaintenanceJobStatus(table);
 *
 * const { status } = yield* getTableMaintenanceJobStatus();
 * for (const [job, state] of Object.entries(status)) {
 *   yield* Effect.log(`${job}: ${state?.status}`);
 * }
 * ```
 */
export interface GetTableMaintenanceJobStatus extends Binding.Service<
  GetTableMaintenanceJobStatus,
  "AWS.S3Tables.GetTableMaintenanceJobStatus",
  (
    table: Table,
  ) => Effect.Effect<
    () => Effect.Effect<
      s3tables.GetTableMaintenanceJobStatusResponse,
      s3tables.GetTableMaintenanceJobStatusError
    >
  >
> {}
export const GetTableMaintenanceJobStatus =
  Binding.Service<GetTableMaintenanceJobStatus>(
    "AWS.S3Tables.GetTableMaintenanceJobStatus",
  );

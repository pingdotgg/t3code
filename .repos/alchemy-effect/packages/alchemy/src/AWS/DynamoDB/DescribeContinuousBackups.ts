import type * as DynamoDB from "@distilled.cloud/aws/dynamodb";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Table } from "./Table.ts";

export interface DescribeContinuousBackupsRequest extends Omit<
  DynamoDB.DescribeContinuousBackupsInput,
  "TableName"
> {}

/**
 * Runtime binding for `dynamodb:DescribeContinuousBackups`.
 *
 * Bind this operation to a `Table` inside a function runtime to get a callable
 * that reads the bound table's continuous-backup and point-in-time-recovery
 * status (including the earliest and latest restorable times), automatically
 * injecting the table name. Provide the `DescribeContinuousBackupsHttp` layer
 * on the Function to satisfy the binding.
 * @binding
 * @section Backup and Restore
 * @example Read the PITR Window
 * ```typescript
 * const describeContinuousBackups =
 *   yield* AWS.DynamoDB.DescribeContinuousBackups(table);
 *
 * const response = yield* describeContinuousBackups();
 * const pitr =
 *   response.ContinuousBackupsDescription?.PointInTimeRecoveryDescription;
 * ```
 */
export interface DescribeContinuousBackups extends Binding.Service<
  DescribeContinuousBackups,
  "AWS.DynamoDB.DescribeContinuousBackups",
  <T extends Table>(
    table: T,
  ) => Effect.Effect<
    (
      request?: DescribeContinuousBackupsRequest,
    ) => Effect.Effect<
      DynamoDB.DescribeContinuousBackupsOutput,
      DynamoDB.DescribeContinuousBackupsError
    >
  >
> {}
export const DescribeContinuousBackups =
  Binding.Service<DescribeContinuousBackups>(
    "AWS.DynamoDB.DescribeContinuousBackups",
  );

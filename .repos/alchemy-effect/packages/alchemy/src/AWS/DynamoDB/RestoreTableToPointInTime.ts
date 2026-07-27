import * as DynamoDB from "@distilled.cloud/aws/dynamodb";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Table } from "./Table.ts";

export interface RestoreTableToPointInTimeRequest extends Omit<
  DynamoDB.RestoreTableToPointInTimeInput,
  "SourceTableArn" | "SourceTableName" | "TargetTableName"
> {}

/**
 * Runtime binding for `dynamodb:RestoreTableToPointInTime`.
 *
 * Bind this operation to a source and a target `Table` inside a function
 * runtime to get a callable that restores the source's point-in-time backup
 * into the target, automatically injecting both table identifiers. The source
 * table must have point-in-time recovery enabled. Provide the
 * `RestoreTableToPointInTimeHttp` layer on the Function to satisfy the
 * binding.
 * @binding
 * @section Backup and Restore
 * @example Restore to the Latest Restorable Time
 * ```typescript
 * const restore = yield* AWS.DynamoDB.RestoreTableToPointInTime(
 *   sourceTable,
 *   restoreTargetTable,
 * );
 *
 * const response = yield* restore({
 *   UseLatestRestorableTime: true,
 * });
 * const status = response.TableDescription?.TableStatus;
 * ```
 */
export interface RestoreTableToPointInTime extends Binding.Service<
  RestoreTableToPointInTime,
  "AWS.DynamoDB.RestoreTableToPointInTime",
  <From extends Table, To extends Table>(
    from: From,
    to: To,
  ) => Effect.Effect<
    (
      request: RestoreTableToPointInTimeRequest,
    ) => Effect.Effect<
      DynamoDB.RestoreTableToPointInTimeOutput,
      DynamoDB.RestoreTableToPointInTimeError
    >
  >
> {}

export const RestoreTableToPointInTime =
  Binding.Service<RestoreTableToPointInTime>(
    "AWS.DynamoDB.RestoreTableToPointInTime",
  );

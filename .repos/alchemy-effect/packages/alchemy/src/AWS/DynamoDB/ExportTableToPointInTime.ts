import type * as DynamoDB from "@distilled.cloud/aws/dynamodb";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Bucket } from "../S3/Bucket.ts";
import type { Table } from "./Table.ts";

export interface ExportTableToPointInTimeRequest extends Omit<
  DynamoDB.ExportTableToPointInTimeInput,
  "TableArn" | "S3Bucket"
> {}

/**
 * Runtime binding for `dynamodb:ExportTableToPointInTime`.
 *
 * Bind this operation to a `Table` and a destination S3 `Bucket` inside a
 * function runtime to get a callable that starts a point-in-time export of
 * the table to the bucket, automatically injecting the table ARN and bucket
 * name. The table must have point-in-time recovery enabled. The deploy-time
 * half grants the export action on the table plus the S3 write permissions
 * the export requires on the bucket. Provide the `ExportTableToPointInTimeHttp`
 * layer on the Function to satisfy the binding.
 * @binding
 * @section Exporting to S3
 * @example Start a Full Export
 * ```typescript
 * const exportTable = yield* AWS.DynamoDB.ExportTableToPointInTime(
 *   table,
 *   bucket,
 * );
 *
 * const response = yield* exportTable({ ExportFormat: "DYNAMODB_JSON" });
 * const exportArn = response.ExportDescription?.ExportArn;
 * ```
 */
export interface ExportTableToPointInTime extends Binding.Service<
  ExportTableToPointInTime,
  "AWS.DynamoDB.ExportTableToPointInTime",
  <T extends Table, B extends Bucket>(
    table: T,
    bucket: B,
  ) => Effect.Effect<
    (
      request?: ExportTableToPointInTimeRequest,
    ) => Effect.Effect<
      DynamoDB.ExportTableToPointInTimeOutput,
      DynamoDB.ExportTableToPointInTimeError
    >
  >
> {}
export const ExportTableToPointInTime =
  Binding.Service<ExportTableToPointInTime>(
    "AWS.DynamoDB.ExportTableToPointInTime",
  );

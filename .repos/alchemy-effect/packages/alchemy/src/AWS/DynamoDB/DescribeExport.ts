import type * as DynamoDB from "@distilled.cloud/aws/dynamodb";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Table } from "./Table.ts";

export interface DescribeExportRequest extends DynamoDB.DescribeExportInput {}

/**
 * Runtime binding for `dynamodb:DescribeExport`.
 *
 * Bind this operation to a `Table` inside a function runtime to get a callable
 * that reads the status of one of the bound table's S3 exports by ARN. The
 * IAM grant covers every export of the bound table (`{tableArn}/export/*`).
 * Provide the `DescribeExportHttp` layer on the Function to satisfy the
 * binding.
 * @binding
 * @section Exporting to S3
 * @example Poll an Export Until It Completes
 * ```typescript
 * const describeExport = yield* AWS.DynamoDB.DescribeExport(table);
 *
 * const response = yield* describeExport({ ExportArn: exportArn });
 * const status = response.ExportDescription?.ExportStatus;
 * ```
 */
export interface DescribeExport extends Binding.Service<
  DescribeExport,
  "AWS.DynamoDB.DescribeExport",
  <T extends Table>(
    table: T,
  ) => Effect.Effect<
    (
      request: DescribeExportRequest,
    ) => Effect.Effect<
      DynamoDB.DescribeExportOutput,
      DynamoDB.DescribeExportError
    >
  >
> {}
export const DescribeExport = Binding.Service<DescribeExport>(
  "AWS.DynamoDB.DescribeExport",
);

import type * as TSW from "@distilled.cloud/aws/timestream-write";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Table } from "./Table.ts";

export interface CreateBatchLoadTaskRequest extends Omit<
  TSW.CreateBatchLoadTaskRequest,
  "TargetDatabaseName" | "TargetTableName"
> {}

/**
 * Runtime binding for `timestream-write:CreateBatchLoadTask` — start a bulk
 * CSV import from S3 into a Timestream {@link Table}.
 *
 * Bind the operation to the target table to get a callable with
 * `TargetDatabaseName` and `TargetTableName` injected automatically; you
 * supply the S3 data source, the report location, and the data model. The
 * binding grants `timestream:CreateBatchLoadTask` on the table and its
 * database; grant the host S3 read on the source bucket and write on the
 * report bucket separately (e.g. via the S3 capability bindings).
 *
 * Provide `Timestream.CreateBatchLoadTaskHttp` on the Function to implement
 * the binding.
 *
 * @binding
 * @section Batch Loading
 * @example Start a bulk CSV import
 * ```typescript
 * // init — bind the operation to the target table
 * const createBatchLoadTask = yield* Timestream.CreateBatchLoadTask(table);
 *
 * // runtime — import CSV rows from S3
 * const task = yield* createBatchLoadTask({
 *   DataSourceConfiguration: {
 *     DataSourceS3Configuration: { BucketName: "my-ingest-bucket", ObjectKeyPrefix: "metrics/" },
 *     DataFormat: "CSV",
 *   },
 *   ReportConfiguration: {
 *     ReportS3Configuration: { BucketName: "my-report-bucket" },
 *   },
 *   DataModelConfiguration: { DataModel: { TimeColumn: "time", TimeUnit: "MILLISECONDS", DimensionMappings: [{ SourceColumn: "host" }], MeasureNameColumn: "measure" } },
 * });
 * // task.TaskId identifies the import for Describe/Resume
 * ```
 */
export interface CreateBatchLoadTask extends Binding.Service<
  CreateBatchLoadTask,
  "AWS.Timestream.CreateBatchLoadTask",
  (
    table: Table,
  ) => Effect.Effect<
    (
      request: CreateBatchLoadTaskRequest,
    ) => Effect.Effect<
      TSW.CreateBatchLoadTaskResponse,
      TSW.CreateBatchLoadTaskError | TSW.DescribeEndpointsError
    >
  >
> {}

export const CreateBatchLoadTask = Binding.Service<CreateBatchLoadTask>(
  "AWS.Timestream.CreateBatchLoadTask",
);

import type * as Logs from "@distilled.cloud/aws/cloudwatch-logs";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { LogGroup } from "./LogGroup.ts";

export interface GetLogRecordRequest extends Logs.GetLogRecordRequest {}

/**
 * Runtime binding for `logs:GetLogRecord` (CloudWatch Logs Insights).
 *
 * Bind this operation to the `LogGroup` an Insights query ran against to
 * fetch the complete log record behind a query-result row: every row returned
 * by {@link import("./GetQueryResults.ts").GetQueryResults} carries a `@ptr`
 * field that identifies the record.
 * @binding
 * @section Logs Insights
 * @example Fetch the Full Record Behind a Query Result
 * ```typescript
 * const getLogRecord = yield* AWS.Logs.GetLogRecord(logGroup);
 *
 * const ptr = row.find((field) => field.field === "@ptr")?.value;
 * const { logRecord } = yield* getLogRecord({ logRecordPointer: ptr! });
 * // logRecord["@message"] is the full unparsed log line
 * ```
 */
export interface GetLogRecord extends Binding.Service<
  GetLogRecord,
  "AWS.Logs.GetLogRecord",
  <G extends LogGroup>(
    logGroup: G,
  ) => Effect.Effect<
    (
      request: GetLogRecordRequest,
    ) => Effect.Effect<Logs.GetLogRecordResponse, Logs.GetLogRecordError>
  >
> {}
export const GetLogRecord = Binding.Service<GetLogRecord>(
  "AWS.Logs.GetLogRecord",
);

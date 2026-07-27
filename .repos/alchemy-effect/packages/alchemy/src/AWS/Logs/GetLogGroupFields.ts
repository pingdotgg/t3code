import type * as Logs from "@distilled.cloud/aws/cloudwatch-logs";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { LogGroup } from "./LogGroup.ts";

export interface GetLogGroupFieldsRequest extends Omit<
  Logs.GetLogGroupFieldsRequest,
  "logGroupName" | "logGroupIdentifier"
> {}

/**
 * Runtime binding for `logs:GetLogGroupFields` (CloudWatch Logs Insights).
 *
 * Bind this operation to a `LogGroup` inside a function runtime to discover
 * the fields present in the group's recent log events (and the percentage of
 * events each field appears in), automatically injecting the log group name.
 * Useful for building Insights queries dynamically.
 * @binding
 * @section Logs Insights
 * @example Discover Fields in a Log Group
 * ```typescript
 * const getLogGroupFields = yield* AWS.Logs.GetLogGroupFields(logGroup);
 *
 * const { logGroupFields } = yield* getLogGroupFields();
 * // e.g. [{ name: "@timestamp", percent: 100 }, { name: "@message", ... }]
 * ```
 */
export interface GetLogGroupFields extends Binding.Service<
  GetLogGroupFields,
  "AWS.Logs.GetLogGroupFields",
  <G extends LogGroup>(
    logGroup: G,
  ) => Effect.Effect<
    (
      request?: GetLogGroupFieldsRequest,
    ) => Effect.Effect<
      Logs.GetLogGroupFieldsResponse,
      Logs.GetLogGroupFieldsError
    >
  >
> {}
export const GetLogGroupFields = Binding.Service<GetLogGroupFields>(
  "AWS.Logs.GetLogGroupFields",
);

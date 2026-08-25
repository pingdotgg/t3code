import type * as Logs from "@distilled.cloud/aws/cloudwatch-logs";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { LogGroup } from "./LogGroup.ts";

export interface StopQueryRequest extends Logs.StopQueryRequest {}

/**
 * Runtime binding for `logs:StopQuery` (CloudWatch Logs Insights).
 *
 * Bind this operation to the `LogGroup` an Insights query was started against
 * (via {@link import("./StartQuery.ts").StartQuery}) to cancel it while it is
 * still `Scheduled` or `Running` — e.g. on caller timeout or shutdown.
 * @binding
 * @section Logs Insights
 * @example Cancel a Running Query
 * ```typescript
 * const startQuery = yield* AWS.Logs.StartQuery(logGroup);
 * const stopQuery = yield* AWS.Logs.StopQuery(logGroup);
 *
 * const { queryId } = yield* startQuery({ queryString, startTime, endTime });
 * const { success } = yield* stopQuery({ queryId: queryId! });
 * ```
 */
export interface StopQuery extends Binding.Service<
  StopQuery,
  "AWS.Logs.StopQuery",
  <G extends LogGroup>(
    logGroup: G,
  ) => Effect.Effect<
    (
      request: StopQueryRequest,
    ) => Effect.Effect<Logs.StopQueryResponse, Logs.StopQueryError>
  >
> {}
export const StopQuery = Binding.Service<StopQuery>("AWS.Logs.StopQuery");

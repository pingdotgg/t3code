import * as im from "@distilled.cloud/aws/internetmonitor";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Monitor } from "./Monitor.ts";

export interface StopQueryRequest extends Omit<
  im.StopQueryInput,
  "MonitorName"
> {}

/**
 * Runtime binding for `internetmonitor:StopQuery` — cancel an in-progress
 * query on the bound {@link Monitor}; the monitor name is injected
 * automatically.
 *
 * Provide `InternetMonitor.StopQueryHttp` on the hosting Lambda Function to
 * satisfy the requirement.
 * @binding
 * @section Querying Measurements
 * @example Cancel a Running Query
 * ```typescript
 * // init — grants internetmonitor:StopQuery on the monitor
 * const stopQuery = yield* AWS.InternetMonitor.StopQuery(monitor);
 *
 * // runtime
 * yield* stopQuery({ QueryId: queryId });
 * ```
 */
export interface StopQuery extends Binding.Service<
  StopQuery,
  "AWS.InternetMonitor.StopQuery",
  (
    monitor: Monitor,
  ) => Effect.Effect<
    (
      request: StopQueryRequest,
    ) => Effect.Effect<im.StopQueryOutput, im.StopQueryError>
  >
> {}

export const StopQuery = Binding.Service<StopQuery>(
  "AWS.InternetMonitor.StopQuery",
);

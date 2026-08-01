import * as im from "@distilled.cloud/aws/internetmonitor";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Monitor } from "./Monitor.ts";

export interface StartQueryRequest extends Omit<
  im.StartQueryInput,
  "MonitorName"
> {}

/**
 * Runtime binding for `internetmonitor:StartQuery` — start a query against
 * the bound {@link Monitor}'s measurement data with the Internet Monitor
 * query interface; the monitor name is injected automatically.
 *
 * Provide `InternetMonitor.StartQueryHttp` on the hosting Lambda Function to
 * satisfy the requirement.
 * @binding
 * @section Querying Measurements
 * @example Start a Measurements Query
 * ```typescript
 * // init — grants internetmonitor:StartQuery on the monitor
 * const startQuery = yield* AWS.InternetMonitor.StartQuery(monitor);
 *
 * // runtime
 * const { QueryId } = yield* startQuery({
 *   StartTime: new Date(Date.now() - 3_600_000),
 *   EndTime: new Date(),
 *   QueryType: "MEASUREMENTS",
 * });
 * ```
 */
export interface StartQuery extends Binding.Service<
  StartQuery,
  "AWS.InternetMonitor.StartQuery",
  (
    monitor: Monitor,
  ) => Effect.Effect<
    (
      request: StartQueryRequest,
    ) => Effect.Effect<im.StartQueryOutput, im.StartQueryError>
  >
> {}

export const StartQuery = Binding.Service<StartQuery>(
  "AWS.InternetMonitor.StartQuery",
);

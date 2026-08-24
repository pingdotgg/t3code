import type * as Credentials from "@distilled.cloud/aws/Credentials";
import type * as Duration from "effect/Duration";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type {
  PrometheusApiError,
  PrometheusInstantResult,
  PrometheusRangeResult,
  PrometheusTime,
} from "./PrometheusTypes.ts";
import type { Workspace } from "./Workspace.ts";

export interface QueryMetricsRequest {
  /** PromQL expression to evaluate, e.g. `up` or `rate(http_requests_total[5m])`. */
  query: string;
  /**
   * Evaluation instant. A `Date`, Unix seconds, or an RFC 3339 string.
   * @default the server's current time
   */
  time?: PrometheusTime;
  /**
   * Evaluation timeout. Capped by the server-side query timeout.
   */
  timeout?: Duration.Input;
}

export interface QueryRangeRequest {
  /** PromQL expression to evaluate over the range. */
  query: string;
  /** Start of the range (inclusive). A `Date`, Unix seconds, or RFC 3339 string. */
  start: PrometheusTime;
  /** End of the range (inclusive). A `Date`, Unix seconds, or RFC 3339 string. */
  end: PrometheusTime;
  /** Resolution step between evaluated points, e.g. `"30 seconds"`. */
  step: Duration.Input;
  /** Evaluation timeout. Capped by the server-side query timeout. */
  timeout?: Duration.Input;
}

export interface QueryMetricsClient {
  /** Evaluate a PromQL expression at a single instant (`api/v1/query`). */
  query(
    request: QueryMetricsRequest,
  ): Effect.Effect<
    PrometheusInstantResult,
    PrometheusApiError | Credentials.CredentialsError
  >;
  /** Evaluate a PromQL expression over a time range (`api/v1/query_range`). */
  queryRange(
    request: QueryRangeRequest,
  ): Effect.Effect<
    PrometheusRangeResult,
    PrometheusApiError | Credentials.CredentialsError
  >;
}

/**
 * Runtime binding for `aps:QueryMetrics` — evaluate PromQL against an AMP
 * {@link Workspace}'s Prometheus-compatible query API (`api/v1/query` and
 * `api/v1/query_range`), SigV4-signed with the host Function's credentials.
 *
 * @binding
 * @section Querying Metrics
 * @example Instant Query
 * ```typescript
 * const metrics = yield* AMP.QueryMetrics(workspace);
 *
 * const result = yield* metrics.query({ query: "up" });
 * if (result.resultType === "vector") {
 *   for (const sample of result.result) {
 *     console.log(sample.metric.__name__, sample.value[1]);
 *   }
 * }
 * ```
 *
 * @example Range Query
 * ```typescript
 * const result = yield* metrics.queryRange({
 *   query: "rate(http_requests_total[5m])",
 *   start: new Date(Date.now() - 3_600_000),
 *   end: new Date(),
 *   step: "30 seconds",
 * });
 * ```
 */
export interface QueryMetrics extends Binding.Service<
  QueryMetrics,
  "AWS.AMP.QueryMetrics",
  (workspace: Workspace) => Effect.Effect<QueryMetricsClient>
> {}
export const QueryMetrics = Binding.Service<QueryMetrics>(
  "AWS.AMP.QueryMetrics",
);

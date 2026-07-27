import * as Data from "effect/Data";

/**
 * Error returned by an AMP workspace's Prometheus-compatible data-plane API
 * (`api/v1/*` under the workspace's `prometheusEndpoint`).
 *
 * Raised when the HTTP request fails, the response is not a 2xx, the body is
 * not valid JSON, or the Prometheus envelope reports `status: "error"`.
 */
export class PrometheusApiError extends Data.TaggedError(
  "AWS.AMP.PrometheusApiError",
)<{
  /** HTTP method of the failed request. */
  readonly method: string;
  /** Path relative to the workspace's `prometheusEndpoint`. */
  readonly path: string;
  /** HTTP status code (`0` when the request never produced a response). */
  readonly status: number;
  /** Raw response body (or the underlying failure message). */
  readonly body: string;
}> {}

/**
 * A point-in-time to send to the Prometheus query API. A `Date` is sent as
 * RFC 3339, a `number` is interpreted as a Unix timestamp in **seconds**
 * (fractional values allowed), and a `string` is passed through verbatim
 * (RFC 3339 or a raw Unix timestamp).
 */
export type PrometheusTime = Date | number | string;

/** One instant-vector sample: metric labels plus a `[unixSeconds, value]` pair. */
export interface PrometheusSample {
  metric: Record<string, string>;
  value: [number, string];
}

/** One range-vector series: metric labels plus `[unixSeconds, value]` pairs. */
export interface PrometheusRangeSample {
  metric: Record<string, string>;
  values: Array<[number, string]>;
}

/**
 * The `data` payload of an instant query (`api/v1/query`). The
 * `resultType` discriminates the shape of `result`.
 */
export type PrometheusInstantResult =
  | { resultType: "vector"; result: PrometheusSample[] }
  | { resultType: "matrix"; result: PrometheusRangeSample[] }
  | { resultType: "scalar"; result: [number, string] }
  | { resultType: "string"; result: [number, string] };

/** The `data` payload of a range query (`api/v1/query_range`). */
export interface PrometheusRangeResult {
  resultType: "matrix";
  result: PrometheusRangeSample[];
}

/** A series descriptor returned by `api/v1/series` — a full label set. */
export type PrometheusSeries = Record<string, string>;

/** Metadata about one metric as returned by `api/v1/metadata`. */
export interface PrometheusMetricMetadata {
  type: string;
  help: string;
  unit: string;
}

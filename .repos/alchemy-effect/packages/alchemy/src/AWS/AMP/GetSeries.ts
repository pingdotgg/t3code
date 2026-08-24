import type * as Credentials from "@distilled.cloud/aws/Credentials";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type {
  PrometheusApiError,
  PrometheusSeries,
  PrometheusTime,
} from "./PrometheusTypes.ts";
import type { Workspace } from "./Workspace.ts";

export interface GetSeriesRequest {
  /** Series selectors — at least one is required, e.g. `['up', 'job:.*']`. */
  match: string[];
  /** Start of the lookup range. A `Date`, Unix seconds, or RFC 3339 string. */
  start?: PrometheusTime;
  /** End of the lookup range. A `Date`, Unix seconds, or RFC 3339 string. */
  end?: PrometheusTime;
}

/**
 * Runtime binding for `aps:GetSeries` — find series (full label sets) that
 * match a selector via an AMP {@link Workspace}'s Prometheus-compatible
 * `api/v1/series` endpoint, SigV4-signed with the host Function's credentials.
 *
 * @binding
 * @section Finding Series
 * @example Match Series by Selector
 * ```typescript
 * const getSeries = yield* AMP.GetSeries(workspace);
 * const series = yield* getSeries({ match: ['{__name__="up"}'] });
 * // [{ __name__: "up", job: "api", instance: "..." }, ...]
 * ```
 */
export interface GetSeries extends Binding.Service<
  GetSeries,
  "AWS.AMP.GetSeries",
  (
    workspace: Workspace,
  ) => Effect.Effect<
    (
      request: GetSeriesRequest,
    ) => Effect.Effect<
      PrometheusSeries[],
      PrometheusApiError | Credentials.CredentialsError
    >
  >
> {}
export const GetSeries = Binding.Service<GetSeries>("AWS.AMP.GetSeries");

import type * as Credentials from "@distilled.cloud/aws/Credentials";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { PrometheusApiError, PrometheusTime } from "./PrometheusTypes.ts";
import type { Workspace } from "./Workspace.ts";

export interface GetLabelsRequest {
  /** Series selectors restricting which series' labels are returned. */
  match?: string[];
  /** Start of the lookup range. A `Date`, Unix seconds, or RFC 3339 string. */
  start?: PrometheusTime;
  /** End of the lookup range. A `Date`, Unix seconds, or RFC 3339 string. */
  end?: PrometheusTime;
}

export interface GetLabelValuesRequest extends GetLabelsRequest {
  /** Label name to list the values of, e.g. `"__name__"` or `"job"`. */
  label: string;
}

export interface GetLabelsClient {
  /** List label names (`api/v1/labels`). */
  labelNames(
    request?: GetLabelsRequest,
  ): Effect.Effect<string[], PrometheusApiError | Credentials.CredentialsError>;
  /** List the values of one label (`api/v1/label/{name}/values`). */
  labelValues(
    request: GetLabelValuesRequest,
  ): Effect.Effect<string[], PrometheusApiError | Credentials.CredentialsError>;
}

/**
 * Runtime binding for `aps:GetLabels` — list label names and label values
 * from an AMP {@link Workspace}'s Prometheus-compatible query API,
 * SigV4-signed with the host Function's credentials.
 *
 * @binding
 * @section Exploring Labels
 * @example List Label Names
 * ```typescript
 * const labels = yield* AMP.GetLabels(workspace);
 * const names = yield* labels.labelNames();
 * ```
 *
 * @example List Metric Names
 * ```typescript
 * const metricNames = yield* labels.labelValues({ label: "__name__" });
 * ```
 */
export interface GetLabels extends Binding.Service<
  GetLabels,
  "AWS.AMP.GetLabels",
  (workspace: Workspace) => Effect.Effect<GetLabelsClient>
> {}
export const GetLabels = Binding.Service<GetLabels>("AWS.AMP.GetLabels");

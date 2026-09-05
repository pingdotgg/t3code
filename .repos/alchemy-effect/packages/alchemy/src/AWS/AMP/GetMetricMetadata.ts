import type * as Credentials from "@distilled.cloud/aws/Credentials";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type {
  PrometheusApiError,
  PrometheusMetricMetadata,
} from "./PrometheusTypes.ts";
import type { Workspace } from "./Workspace.ts";

export interface GetMetricMetadataRequest {
  /** Restrict metadata to one metric name. */
  metric?: string;
  /** Maximum number of metrics to return. */
  limit?: number;
}

/**
 * Runtime binding for `aps:GetMetricMetadata` — read metric metadata (type,
 * help, unit) from an AMP {@link Workspace}'s Prometheus-compatible
 * `api/v1/metadata` endpoint, SigV4-signed with the host Function's
 * credentials.
 *
 * @binding
 * @section Reading Metric Metadata
 * @example All Metric Metadata
 * ```typescript
 * const getMetricMetadata = yield* AMP.GetMetricMetadata(workspace);
 * const metadata = yield* getMetricMetadata({});
 * // { http_requests_total: [{ type: "counter", help: "...", unit: "" }], ... }
 * ```
 */
export interface GetMetricMetadata extends Binding.Service<
  GetMetricMetadata,
  "AWS.AMP.GetMetricMetadata",
  (
    workspace: Workspace,
  ) => Effect.Effect<
    (
      request: GetMetricMetadataRequest,
    ) => Effect.Effect<
      Record<string, PrometheusMetricMetadata[]>,
      PrometheusApiError | Credentials.CredentialsError
    >
  >
> {}
export const GetMetricMetadata = Binding.Service<GetMetricMetadata>(
  "AWS.AMP.GetMetricMetadata",
);

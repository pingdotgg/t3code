import type * as Credentials from "@distilled.cloud/aws/Credentials";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { PrometheusApiError } from "./PrometheusTypes.ts";
import type { Workspace } from "./Workspace.ts";

export interface RemoteWriteSample {
  /** Sample value. */
  value: number;
  /**
   * Sample timestamp in epoch **milliseconds**.
   * @default the time of the remote-write call
   */
  timestamp?: number;
}

export interface RemoteWriteSeries {
  /** Metric name (becomes the `__name__` label). */
  name: string;
  /** Additional labels for the series. */
  labels?: Record<string, string>;
  /** Samples to append, oldest first. */
  samples: RemoteWriteSample[];
}

export interface RemoteWriteRequest {
  /** Time series to write. */
  timeseries: RemoteWriteSeries[];
}

/**
 * Runtime binding for `aps:RemoteWrite` — push metric samples into an AMP
 * {@link Workspace} via its Prometheus remote-write endpoint
 * (`api/v1/remote_write`), SigV4-signed with the host Function's credentials.
 *
 * The protobuf + snappy remote-write body is encoded internally — callers
 * pass plain metric names, labels, and samples.
 *
 * @binding
 * @section Writing Metrics
 * @example Push a Counter Sample
 * ```typescript
 * const remoteWrite = yield* AMP.RemoteWrite(workspace);
 *
 * yield* remoteWrite({
 *   timeseries: [{
 *     name: "jobs_processed_total",
 *     labels: { queue: "default" },
 *     samples: [{ value: 42 }],
 *   }],
 * });
 * ```
 *
 * @example Backfill Samples with Explicit Timestamps
 * ```typescript
 * yield* remoteWrite({
 *   timeseries: [{
 *     name: "temperature_celsius",
 *     labels: { sensor: "a1" },
 *     samples: [
 *       { value: 20.1, timestamp: Date.now() - 60_000 },
 *       { value: 20.4, timestamp: Date.now() },
 *     ],
 *   }],
 * });
 * ```
 */
export interface RemoteWrite extends Binding.Service<
  RemoteWrite,
  "AWS.AMP.RemoteWrite",
  (
    workspace: Workspace,
  ) => Effect.Effect<
    (
      request: RemoteWriteRequest,
    ) => Effect.Effect<void, PrometheusApiError | Credentials.CredentialsError>
  >
> {}
export const RemoteWrite = Binding.Service<RemoteWrite>("AWS.AMP.RemoteWrite");

import type * as bqdt from "@distilled.cloud/gcp/bigquerydatatransfer_v1";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { RuntimeContext } from "../../RuntimeContext.ts";
import type { TransferConfig } from "./TransferConfig.ts";

export interface StartManualRunsRequest extends Omit<
  bqdt.StartManualRunsProjectsLocationsTransferConfigsRequest,
  "parent"
> {}

/**
 * Runtime binding for BigQuery Data Transfer `transferConfigs.startManualRuns`.
 *
 * Starts one or more transfer runs for a {@link TransferConfig}. Bind this
 * operation in a Function/Action init phase. Provide
 * {@link StartManualRunsHttp}. `requestedRunTime` and `requestedTimeRange`
 * must be in the past.
 *
 * Grants `roles/bigquery.admin` on the project because
 * `bigquery.transfers.update` (required by `startManualRuns`) is in no
 * narrower predefined role, and transfer configs have no resource-level
 * IAM or IAM Conditions support to scope it to the one config.
 *
 * ### Starting Manual Runs
 * **Example:** Run for a specific past timestamp
 * ```typescript
 * const start = yield* GCP.BigQueryDataTransfer.StartManualRuns(nightly);
 * const result = yield* start({
 *   body: { requestedRunTime: "2020-01-01T00:00:00Z" },
 * });
 * ```
 *
 * @binding
 * @category BigQueryDataTransfer
 */
export interface StartManualRuns extends Binding.Service<
  StartManualRuns,
  "GCP.BigQueryDataTransfer.StartManualRuns",
  (
    config: TransferConfig,
  ) => Effect.Effect<
    (
      request?: StartManualRunsRequest,
    ) => Effect.Effect<
      bqdt.StartManualTransferRunsResponse,
      bqdt.StartManualRunsProjectsLocationsTransferConfigsError,
      RuntimeContext
    >
  >
> {}

export const StartManualRuns = Binding.Service<StartManualRuns>(
  "GCP.BigQueryDataTransfer.StartManualRuns",
);

import * as bqdt from "@distilled.cloud/gcp/bigquerydatatransfer_v1";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as GCPBindings from "../GCPBindings.ts";
import { StartManualRuns, type StartManualRunsRequest } from "./StartManualRuns.ts";
import type { TransferConfig } from "./TransferConfig.ts";

/**
 * HTTP implementation of {@link StartManualRuns}.
 *
 * @layer
 * @provides GCP.BigQueryDataTransfer.StartManualRuns
 */
export const StartManualRunsHttp = Layer.effect(
  StartManualRuns,
  Effect.gen(function* () {
    const bind = yield* GCPBindings.Bind;
    const startManualRunsProjectsLocationsTransferConfigs = yield* GCPBindings.withCredentials(
      bqdt.startManualRunsProjectsLocationsTransferConfigs,
    );
    return Effect.fn(function* (config: TransferConfig) {
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        yield* bind`GCP.BigQueryDataTransfer.StartManualRuns(${config})`({
          // bigquery.transfers.update is in no narrower predefined role, and
          // transfer configs have no resource-level IAM, so this is a project
          // grant (see StartManualRuns JSDoc).
          iam: [{ role: "roles/bigquery.admin" }],
        });
      }
      const name = yield* config.name;
      return Effect.fn(`GCP.BigQueryDataTransfer.StartManualRuns(${config.LogicalId})`)(function* (
        request?: StartManualRunsRequest,
      ) {
        return yield* startManualRunsProjectsLocationsTransferConfigs({
          ...request,
          parent: yield* name,
        });
      });
    });
  }),
);

import * as GCP from "@/GCP";
import * as Effect from "effect/Effect";
import { serveProbes } from "../../bindingHost.ts";

/** Scheduled query the host starts runs of (roles/bigquery.admin, project). */
export const Nightly = Effect.gen(function* () {
  const dataset = yield* GCP.BigQuery.Dataset("Analytics", {
    location: "US-CENTRAL1",
    forceDestroy: true,
  });
  return yield* GCP.BigQueryDataTransfer.TransferConfig("Nightly", {
    location: "us-central1",
    dataSourceId: "scheduled_query",
    destinationDatasetId: dataset.datasetId,
    scheduleOptions: { disableAutoScheduling: true },
    params: {
      query: "SELECT 1 AS n",
      destination_table_name_template: "nightly",
      write_disposition: "WRITE_TRUNCATE",
    },
  });
});

/**
 * Effect-native Cloud Run service exercising every BigQuery Data Transfer
 * binding as its own runtime service account. Deployed from
 * {@link ../Bindings.test.ts}.
 */
export default class BigQueryDataTransferBindingsHost extends GCP.Function<BigQueryDataTransferBindingsHost>()(
  "BigQueryDataTransferBindingsHost",
  { main: import.meta.url, invokerIamDisabled: true },
  Effect.gen(function* () {
    const start = yield* GCP.BigQueryDataTransfer.StartManualRuns(Nightly);

    return {
      fetch: serveProbes({
        startManualRuns: start({
          body: { requestedRunTime: "2020-01-01T00:00:00Z" },
        }),
      }),
    };
  }).pipe(Effect.provide(GCP.BigQueryDataTransfer.StartManualRunsHttp)),
) {}

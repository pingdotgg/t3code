import * as GCP from "@/GCP";
import * as Output from "@/Output";
import * as Effect from "effect/Effect";

/**
 * A BigQuery table Feature Groups can register as their source: one row
 * per `entity_id` with an `age` feature column.
 */
export const UsersSource = Effect.gen(function* () {
  const dataset = yield* GCP.BigQuery.Dataset("FeatureSource", {
    location: "US-CENTRAL1",
    forceDestroy: true,
  });
  const table = yield* GCP.BigQuery.Table("FeatureSourceTable", {
    datasetId: dataset.datasetId,
    schema: [
      { name: "entity_id", type: "STRING", mode: "REQUIRED" },
      { name: "age", type: "INTEGER" },
      { name: "feature_timestamp", type: "TIMESTAMP" },
    ],
  });
  return Output.interpolate`bq://${table.project}.${table.datasetId}.${table.tableId}`;
});

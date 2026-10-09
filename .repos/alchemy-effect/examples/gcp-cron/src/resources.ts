import * as GCP from "alchemy/GCP";
import * as Effect from "effect/Effect";

/** The warehouse every scheduled run reports into. */
export const Monitoring = GCP.BigQuery.Dataset("Monitoring", {
  forceDestroy: true,
});

/**
 * One row per scheduled run. `kind` says which schedule fired, and
 * `value` is what that run computed: the delivery lag for a heartbeat,
 * the number of heartbeats seen in the last day for the daily rollup.
 */
export const Heartbeats = Effect.gen(function* () {
  const dataset = yield* Monitoring;
  return yield* GCP.BigQuery.Table("Heartbeats", {
    datasetId: dataset.datasetId,
    tableId: "heartbeats",
    schema: [
      { name: "kind", type: "STRING", mode: "REQUIRED" },
      { name: "jobName", type: "STRING", mode: "REQUIRED" },
      { name: "scheduleTime", type: "TIMESTAMP", mode: "REQUIRED" },
      { name: "receivedAt", type: "TIMESTAMP", mode: "REQUIRED" },
      { name: "value", type: "INTEGER", mode: "REQUIRED" },
    ],
  });
});

/** The row both schedules write. */
export type HeartbeatRow = {
  kind: "heartbeat" | "daily";
  jobName: string;
  scheduleTime: Date;
  receivedAt: Date;
  value: number;
};

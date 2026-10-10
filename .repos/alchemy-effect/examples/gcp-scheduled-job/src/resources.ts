import * as GCP from "alchemy/GCP";
import * as Effect from "effect/Effect";

/** The warehouse the nightly job reads from. */
export const Warehouse = GCP.BigQuery.Dataset("Warehouse", {
  forceDestroy: true,
});

/**
 * One row per order. Amounts are integer cents so the sums the job
 * computes are exact.
 */
export const Orders = Effect.gen(function* () {
  const dataset = yield* Warehouse;
  return yield* GCP.BigQuery.Table("Orders", {
    datasetId: dataset.datasetId,
    tableId: "orders",
    schema: [
      { name: "id", type: "STRING", mode: "REQUIRED" },
      { name: "region", type: "STRING", mode: "REQUIRED" },
      { name: "amountCents", type: "INTEGER", mode: "REQUIRED" },
      { name: "occurredAt", type: "TIMESTAMP", mode: "REQUIRED" },
    ],
  });
});

/**
 * Where the daily summaries land, one JSON object per day under
 * `daily/`. `forceDestroy` empties the bucket on `alchemy destroy`; drop
 * it in production so a destroy cannot take the reports with it.
 */
export const Reports = GCP.Storage.Bucket("Reports", {
  forceDestroy: true,
});

/** Summaries are written under this prefix. */
export const SUMMARY_PREFIX = "daily/";

/** `daily/2026-09-27.json` for a window ending on that UTC day. */
export const summaryKey = (windowEnd: Date) =>
  `${SUMMARY_PREFIX}${windowEnd.toISOString().slice(0, 10)}.json`;

/** Per-region totals inside a {@link DailySummary}. */
export interface RegionTotal {
  region: string;
  orders: number;
  revenueCents: number;
}

/** The JSON document the job writes for each run. */
export interface DailySummary {
  /** Start of the 24-hour window (inclusive, RFC3339). */
  from: string;
  /** End of the window (exclusive, RFC3339) — the moment the run started. */
  to: string;
  /** The Cloud Run execution that produced this summary, if known. */
  execution: string | null;
  orders: number;
  revenueCents: number;
  regions: RegionTotal[];
}

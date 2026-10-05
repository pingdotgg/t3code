import * as GCP from "alchemy/GCP";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import {
  Orders,
  Reports,
  summaryKey,
  type DailySummary,
  type RegionTotal,
} from "./resources.ts";

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The nightly batch: roll the last 24 hours of orders up into one JSON
 * summary in Cloud Storage.
 *
 * A Cloud Run Job runs to completion and exits, so nothing is billed
 * between runs. It is started by Cloud Scheduler every night and by the
 * admin route in {@link ../Admin.ts} on demand; both paths create a new
 * execution through the Cloud Run Admin API.
 *
 * Re-running is safe: a run for the same day overwrites that day's
 * object with a fresh aggregate.
 */
export default class Summarize extends GCP.Run.Job<Summarize>()(
  "Summarize",
  {
    main: import.meta.url,
    // A failed summary is retried once, then the execution fails and the
    // next trigger tries again.
    maxRetries: 1,
    timeout: "300s",
  },
  Effect.gen(function* () {
    const table = yield* Orders;
    const orders = yield* GCP.BigQuery.ReadTable(table);
    const reports = yield* GCP.Storage.WriteBucket(Reports);
    // The table id is bound at deploy time and read inside `run`.
    const tableId = yield* table.tableId;

    return {
      run: Effect.gen(function* () {
        const to = new Date(yield* Clock.currentTimeMillis);
        const from = new Date(to.getTime() - DAY_MS);
        // Cloud Run names each execution in the task's environment.
        const execution = yield* Effect.sync(
          () => process.env.CLOUD_RUN_EXECUTION ?? null,
        );

        // Unqualified table names resolve against the table's dataset.
        const rows = yield* orders.query(
          `SELECT region, COUNT(*) AS orders, SUM(amountCents) AS revenueCents
           FROM \`${yield* tableId}\`
           WHERE occurredAt >= TIMESTAMP(@from) AND occurredAt < TIMESTAMP(@to)
           GROUP BY region
           ORDER BY region`,
          { from: from.toISOString(), to: to.toISOString() },
        );

        const regions: RegionTotal[] = rows.map((row) => ({
          region: String(row.region),
          orders: Number(row.orders),
          revenueCents: Number(row.revenueCents ?? 0),
        }));

        const summary: DailySummary = {
          from: from.toISOString(),
          to: to.toISOString(),
          execution,
          orders: regions.reduce((n, r) => n + r.orders, 0),
          revenueCents: regions.reduce((n, r) => n + r.revenueCents, 0),
          regions,
        };

        const key = summaryKey(to);
        yield* reports.put(key, JSON.stringify(summary, null, 2), {
          contentType: "application/json",
        });
        yield* Effect.log(
          `summarize: ${summary.orders} order(s) in ${regions.length} region(s) -> ${key}`,
        );
      }).pipe(Effect.orDie),
    };
  }).pipe(
    Effect.provide([GCP.BigQuery.ReadTableHttp, GCP.Storage.WriteBucketHttp]),
  ),
) {}

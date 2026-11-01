import * as GCP from "alchemy/GCP";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import { Heartbeats, type HeartbeatRow } from "./resources.ts";

/** Most rows `GET /heartbeats` returns. */
const MAX_LIMIT = 100;

/**
 * A Cloud Run service with two cron handlers and one read route.
 *
 * Each `consumeSchedule` creates a Cloud Scheduler job that `POST`s to a
 * private path on this service with an OIDC token for the service's own
 * runtime account. The runtime verifies that token before the handler
 * runs, so the schedule routes stay closed to the public even though
 * `GET /heartbeats` is open.
 *
 * - every minute — record a heartbeat and how late it was delivered.
 * - daily at midnight UTC — count the last day's heartbeats and record it.
 * - `GET /heartbeats?kind=&limit=` — the most recent rows, newest first.
 */
export default class Monitor extends GCP.Function<Monitor>()(
  "Monitor",
  {
    main: import.meta.url,
    // Opens `GET /heartbeats`. The schedule routes still reject any
    // request without a valid token from Cloud Scheduler.
    invokerIamDisabled: true,
  },
  Effect.gen(function* () {
    const table = yield* Heartbeats;
    const writer = yield* GCP.BigQuery.WriteTable(table);
    const reader = yield* GCP.BigQuery.ReadTable(table);
    // The table id is bound at deploy time and read inside handlers.
    const tableId = yield* table.tableId;

    const record = (row: HeartbeatRow) =>
      writer.insert([row]).pipe(Effect.orDie);

    yield* GCP.CloudScheduler.consumeSchedule(
      "Heartbeat",
      { schedule: "* * * * *", timeZone: "Etc/UTC" },
      (event) =>
        Effect.gen(function* () {
          const receivedAt = new Date();
          const scheduleTime = event.scheduleTime
            ? new Date(event.scheduleTime)
            : receivedAt;
          yield* record({
            kind: "heartbeat",
            jobName: event.jobName,
            scheduleTime,
            receivedAt,
            value: receivedAt.getTime() - scheduleTime.getTime(),
          });
        }),
    );

    yield* GCP.CloudScheduler.consumeSchedule(
      "DailyRollup",
      { schedule: "0 0 * * *", timeZone: "Etc/UTC" },
      (event) =>
        Effect.gen(function* () {
          const heartbeats = yield* tableId;
          const [counted] = yield* reader
            .query(
              `SELECT COUNT(*) AS n FROM \`${heartbeats}\`
               WHERE kind = 'heartbeat'
                 AND receivedAt >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 1 DAY)`,
            )
            .pipe(Effect.orDie);
          const receivedAt = new Date();
          yield* record({
            kind: "daily",
            jobName: event.jobName,
            scheduleTime: event.scheduleTime
              ? new Date(event.scheduleTime)
              : receivedAt,
            receivedAt,
            value: Number(counted?.n ?? 0),
          });
        }),
    );

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.originalUrl);

        if (request.method === "GET" && url.pathname === "/") {
          return HttpServerResponse.text("ok");
        }

        if (request.method === "GET" && url.pathname === "/heartbeats") {
          const kind = url.searchParams.get("kind");
          const limit = Math.min(
            Math.max(Number(url.searchParams.get("limit") ?? 20) || 20, 1),
            MAX_LIMIT,
          );
          const heartbeats = yield* tableId;
          const rows = yield* reader
            .query(
              `SELECT kind, jobName, scheduleTime, receivedAt, value
               FROM \`${heartbeats}\`
               ${kind ? "WHERE kind = @kind" : ""}
               ORDER BY receivedAt DESC
               LIMIT @limit`,
              kind ? { kind, limit } : { limit },
            )
            .pipe(Effect.orDie);
          return yield* HttpServerResponse.json({ heartbeats: rows });
        }

        return yield* HttpServerResponse.json(
          { error: "not found" },
          { status: 404 },
        );
      }),
    };
  }).pipe(
    Effect.provide([
      GCP.Run.ScheduleEventSource,
      GCP.BigQuery.WriteTableHttp,
      GCP.BigQuery.ReadTableHttp,
    ]),
  ),
) {}

import * as GCP from "alchemy/GCP";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import Drain from "./Drain.ts";
import { Events, EventsTable, type EventRow } from "./resources.ts";

/**
 * The front door of an analytics pipeline.
 *
 * Producers post events; the service publishes them to Pub/Sub and
 * returns. Nothing touches BigQuery on the request path, so a slow
 * warehouse or a schema change cannot take the ingest endpoint down —
 * the messages just queue up until {@link Drain} runs.
 *
 * - `POST /events` — accept an event and publish it.
 * - `POST /drain` — start a drain now, instead of waiting for a schedule.
 * - `GET /events/count` — count what has landed in BigQuery.
 */
export default class Ingest extends GCP.Function<Ingest>()(
  "Ingest",
  {
    main: import.meta.url,
    invokerIamDisabled: true,
  },
  Effect.gen(function* () {
    const topic = yield* Events;
    const table = yield* EventsTable;
    const drain = yield* Drain;

    // pubsub.publisher on the topic only.
    const publisher = yield* GCP.PubSub.WriteTopic(topic);
    // bigquery.dataViewer on the table, plus bigquery.jobUser on the
    // project — BigQuery only grants running query jobs there.
    const warehouse = yield* GCP.BigQuery.ReadTable(table);
    // Binding a Job to a Service grants run.jobsExecutorWithOverrides on
    // the job — this is how one host triggers another.
    const runDrain = yield* GCP.Run.RunJob(drain);

    // An accessor: the table id is bound at deploy time and read back
    // inside the handler.
    const tableId = yield* table.tableId;

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.originalUrl);

        if (request.method === "GET" && url.pathname === "/") {
          return HttpServerResponse.text("ok");
        }

        if (request.method === "POST" && url.pathname === "/events") {
          const body = (yield* request.json) as {
            type?: string;
            payload?: unknown;
          };
          if (!body.type) {
            return yield* HttpServerResponse.json(
              { error: "type is required" },
              { status: 400 },
            );
          }

          const event: EventRow = {
            id: crypto.randomUUID(),
            type: body.type,
            occurredAt: new Date().toISOString(),
            payload: JSON.stringify(body.payload ?? {}),
          };

          yield* publisher
            .publish({
              data: JSON.stringify(event),
              // Attributes are queryable without decoding the body,
              // which lets a filtered subscription fan out by type.
              attributes: { type: event.type },
            })
            .pipe(Effect.orDie);

          return yield* HttpServerResponse.json(
            { id: event.id },
            { status: 202 },
          );
        }

        // Cloud Run Jobs are asynchronous: this returns as soon as the
        // execution is created, not when it finishes.
        if (request.method === "POST" && url.pathname === "/drain") {
          const operation = yield* runDrain().pipe(Effect.orDie);
          return yield* HttpServerResponse.json(
            { execution: operation.name ?? null },
            { status: 202 },
          );
        }

        if (request.method === "GET" && url.pathname === "/events/count") {
          const type = url.searchParams.get("type");
          const events = yield* tableId;
          // Unqualified table names resolve against the bound table's
          // dataset; `params` become named `@type` parameters.
          const rows = yield* warehouse
            .query(
              type
                ? `SELECT COUNT(*) AS n FROM \`${events}\` WHERE type = @type`
                : `SELECT COUNT(*) AS n FROM \`${events}\``,
              type ? { type } : undefined,
            )
            .pipe(Effect.orDie);

          return yield* HttpServerResponse.json({
            count: Number(rows[0]?.n ?? 0),
          });
        }

        return yield* HttpServerResponse.json(
          { error: "not found" },
          { status: 404 },
        );
      }),
    };
  }).pipe(
    Effect.provide([
      GCP.PubSub.WriteTopicHttp,
      GCP.BigQuery.ReadTableHttp,
      GCP.Run.RunJobHttp,
    ]),
  ),
) {}

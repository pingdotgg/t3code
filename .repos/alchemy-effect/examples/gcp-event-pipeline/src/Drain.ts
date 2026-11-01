import * as GCP from "alchemy/GCP";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { EventsTable, Inbox, type EventRow } from "./resources.ts";

/** One pull returns at most this many messages. */
const BATCH = 100;

/**
 * The batch half of the pipeline: drain Pub/Sub into BigQuery.
 *
 * A Cloud Run Job is the right host for this. It runs to completion and
 * exits, so nothing is billed between drains, and Cloud Scheduler or an
 * operator can start it whenever a batch is due.
 *
 * The order matters: insert first, ack second. A crash between them
 * redelivers the batch and duplicates rows, which a `SELECT DISTINCT id`
 * removes; acking first would lose events outright.
 */
export default class Drain extends GCP.Run.Job<Drain>()(
  "Drain",
  {
    main: import.meta.url,
  },
  Effect.gen(function* () {
    const inbox = yield* Inbox;
    const table = yield* EventsTable;

    // pubsub.subscriber on the subscription, and bigquery.dataEditor on
    // the table — nothing on the project.
    const subscription = yield* GCP.PubSub.ReadSubscription(inbox);
    const warehouse = yield* GCP.BigQuery.WriteTable(table);

    return {
      // A pull may return fewer messages than are waiting, so drain
      // batch by batch until one comes back empty.
      run: Effect.gen(function* () {
        // A pull waits for messages; an empty subscription answers
        // nothing, so a quiet 10 seconds means the backlog is drained.
        const received = yield* subscription
          .pull({ maxMessages: BATCH })
          .pipe(Effect.timeoutOption("10 seconds"));
        const messages = Option.getOrElse(received, () => []);
        if (messages.length === 0) {
          yield* Effect.log("drain: nothing left");
          return 0;
        }

        const rows = messages.map(
          (message) => JSON.parse(message.text) as EventRow,
        );

        // insertIds make the streaming insert idempotent inside
        // BigQuery's dedup window, so a redelivered batch collapses.
        yield* warehouse.insert(rows, { insertIds: rows.map((row) => row.id) });

        yield* subscription.acknowledge(
          messages.map((message) => message.ackId),
        );

        yield* Effect.log(`drain: wrote ${rows.length} row(s)`);
        return messages.length;
      }).pipe(
        Effect.repeat({ until: (count) => count === 0 }),
        Effect.asVoid,
        Effect.orDie,
      ),
    };
  }).pipe(
    Effect.provide([
      GCP.PubSub.ReadSubscriptionHttp,
      GCP.BigQuery.WriteTableHttp,
    ]),
  ),
) {}

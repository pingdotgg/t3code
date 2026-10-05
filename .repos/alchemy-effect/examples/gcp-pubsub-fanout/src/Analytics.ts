import * as GCP from "alchemy/GCP";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import {
  decodeOrderEvent,
  OrderEvents,
  OrderEventsTable,
} from "./resources.ts";

/**
 * Records every order event, of every type, as a row in BigQuery.
 *
 * No filter: this subscription receives everything published to the
 * topic, including the events the email consumer never sees and the
 * ones it dead-letters.
 */
export default class Analytics extends GCP.Function<Analytics>()(
  "Analytics",
  {
    main: import.meta.url,
  },
  Effect.gen(function* () {
    const table = yield* GCP.BigQuery.WriteTable(OrderEventsTable);

    yield* GCP.PubSub.consumeTopicMessages(OrderEvents, (messages) =>
      messages.pipe(
        Stream.runForEach(({ message }) =>
          Effect.gen(function* () {
            const event = yield* decodeOrderEvent(message.data);
            yield* table.insert(
              [
                {
                  eventId: event.eventId,
                  type: event.type,
                  orderId: event.orderId,
                  email: event.email,
                  total: event.total,
                  occurredAt: new Date(event.occurredAt),
                  receivedAt: new Date(),
                },
              ],
              // BigQuery drops a repeated insertId within its dedup
              // window, so a redelivered event does not add a second row.
              { insertIds: [event.eventId] },
            );
            yield* Effect.log(`analytics: ${event.type} ${event.orderId}`);
          }),
        ),
        Effect.orDie,
      ),
    );

    return {
      fetch: Effect.succeed(HttpServerResponse.text("ok")),
    };
  }).pipe(
    Effect.provide([GCP.Run.TopicEventSource, GCP.BigQuery.WriteTableHttp]),
  ),
) {}

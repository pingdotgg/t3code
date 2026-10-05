import * as GCP from "alchemy/GCP";
import * as Effect from "effect/Effect";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import { LOCATION, Shop } from "./resources.ts";

/**
 * Reacts to every new order by writing an `audit/{id}` document.
 *
 * The service is private (the default): only the Eventarc trigger, which
 * signs each delivery with this service's own identity, can invoke it.
 *
 * Firestore events arrive as `application/protobuf`, so `event.data` is a
 * `Uint8Array` of a `DocumentEventData` message. The CloudEvent attributes
 * already name the document (`document: "orders/{id}"`), which is all an
 * audit trail needs; a reaction that needs the fields either decodes the
 * protobuf or reads the document back by that path.
 */
export default class Auditor extends GCP.Function<Auditor>()(
  "Auditor",
  {
    main: import.meta.url,
  },
  Effect.gen(function* () {
    const shop = yield* Shop;
    // roles/datastore.user on the project, conditioned on this database.
    const db = yield* GCP.Firestore.WriteDatabase(shop);

    // Grants this service's account roles/eventarc.eventReceiver on the
    // project and roles/run.invoker on the service, then creates the
    // trigger in the database's location.
    yield* GCP.Eventarc.consumeEvents(
      "OrderCreated",
      {
        location: LOCATION,
        eventFilters: [
          {
            attribute: "type",
            value: "google.cloud.firestore.document.v1.created",
          },
          { attribute: "database", value: shop.databaseId },
          {
            attribute: "document",
            value: "orders/{id}",
            operator: "match-path-pattern",
          },
        ],
      },
      (event) =>
        Effect.gen(function* () {
          const document = event.attributes.document ?? "";
          const id = document.split("/")[1];
          if (id === undefined) return;
          yield* Effect.log(`audit ${document} (${event.type} ${event.id})`);

          // `create` makes redelivery harmless: Eventarc is at-least-once,
          // and a second delivery of the same event finds the audit entry
          // already there.
          yield* db
            .create(`audit/${id}`, {
              order: document,
              eventId: event.id,
              eventType: event.type,
              eventTime: event.time ?? null,
              payloadBytes:
                event.data instanceof Uint8Array ? event.data.length : null,
            })
            .pipe(
              Effect.catchTag(
                "GCP.Firestore.DocumentAlreadyExists",
                () => Effect.void,
              ),
              // A failure answers 500, and Eventarc redelivers later.
              Effect.orDie,
            );
        }),
    );

    return { fetch: Effect.succeed(HttpServerResponse.text("ok")) };
  }).pipe(
    Effect.provide(GCP.Firestore.WriteDatabaseHttp),
    Effect.provide(GCP.Run.EventarcEventSource),
  ),
) {}

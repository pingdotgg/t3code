import * as GCP from "alchemy/GCP";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import { OrderEvents, type OrderEvent } from "./resources.ts";

const badRequest = (error: string) =>
  HttpServerResponse.json({ error }, { status: 400 });

/**
 * The public orders API — the producer.
 *
 * It publishes one event per state change and returns. It knows nothing
 * about who consumes the events: adding a consumer is a new subscription
 * on the topic, not a change here.
 *
 * - `POST /orders` — `{ email, total }` → publishes `order.created`,
 *   returns `202 { orderId, eventId }`.
 * - `POST /orders/:id/cancel` — `{ email }` → publishes `order.cancelled`,
 *   returns `202 { orderId, eventId }`.
 */
export default class Orders extends GCP.Function<Orders>()(
  "Orders",
  {
    main: import.meta.url,
    invokerIamDisabled: true,
  },
  Effect.gen(function* () {
    const events = yield* GCP.PubSub.WriteTopic(OrderEvents);

    const publish = (event: OrderEvent) =>
      events
        .publish({
          data: JSON.stringify(event),
          // Subscription filters match attributes, never the body, so the
          // type goes here as well.
          attributes: { type: event.type },
        })
        .pipe(Effect.orDie);

    const accepted = (event: OrderEvent) =>
      HttpServerResponse.json(
        { orderId: event.orderId, eventId: event.eventId },
        { status: 202 },
      );

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.originalUrl);
        const segments = url.pathname.split("/").filter(Boolean);

        if (request.method === "GET" && segments.length === 0) {
          return HttpServerResponse.text("ok");
        }

        if (request.method !== "POST" || segments[0] !== "orders") {
          return yield* HttpServerResponse.json(
            { error: "not found" },
            { status: 404 },
          );
        }

        const body = (yield* request.json.pipe(
          Effect.orElseSucceed(() => ({})),
        )) as { email?: unknown; total?: unknown };
        if (typeof body.email !== "string" || !body.email.includes("@")) {
          return yield* badRequest("email is required");
        }

        if (segments.length === 1) {
          if (typeof body.total !== "number" || body.total <= 0) {
            return yield* badRequest("total must be a positive number");
          }
          const event: OrderEvent = {
            eventId: crypto.randomUUID(),
            type: "order.created",
            orderId: crypto.randomUUID(),
            email: body.email,
            total: body.total,
            occurredAt: new Date().toISOString(),
          };
          yield* publish(event);
          return yield* accepted(event);
        }

        if (segments.length === 3 && segments[2] === "cancel") {
          const event: OrderEvent = {
            eventId: crypto.randomUUID(),
            type: "order.cancelled",
            orderId: segments[1]!,
            email: body.email,
            total: 0,
            occurredAt: new Date().toISOString(),
          };
          yield* publish(event);
          return yield* accepted(event);
        }

        return yield* HttpServerResponse.json(
          { error: "not found" },
          { status: 404 },
        );
      }),
    };
  }).pipe(Effect.provide(GCP.PubSub.WriteTopicHttp)),
) {}

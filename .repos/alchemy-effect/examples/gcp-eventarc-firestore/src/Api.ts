import * as GCP from "alchemy/GCP";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import { Shop, type Order } from "./resources.ts";

/**
 * The public front door: it writes orders and does nothing else.
 *
 * Everything that should happen *because* an order exists — auditing,
 * fulfilment, notifications — hangs off Firestore's change stream in
 * {@link ../Auditor.ts}, so adding a reaction never touches this service.
 *
 * - `POST /orders` — store `{ item, quantity }` at `orders/{id}`.
 */
export default class Api extends GCP.Function<Api>()(
  "Api",
  {
    main: import.meta.url,
    invokerIamDisabled: true,
  },
  Effect.gen(function* () {
    const shop = yield* Shop;
    // roles/datastore.user on the project, conditioned on this database.
    const db = yield* GCP.Firestore.WriteDatabase(shop);

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.originalUrl);

        if (request.method === "GET" && url.pathname === "/") {
          return HttpServerResponse.text("ok");
        }

        if (request.method === "POST" && url.pathname === "/orders") {
          const body = (yield* request.json) as {
            item?: string;
            quantity?: number;
          };
          if (!body.item) {
            return yield* HttpServerResponse.json(
              { error: "item is required" },
              { status: 400 },
            );
          }

          const id = crypto.randomUUID();
          const order: Order = {
            item: body.item,
            quantity: body.quantity ?? 1,
            createdAt: new Date(),
          };
          // `create` rather than `set`: a create is what emits the
          // `document.v1.created` event the auditor listens for.
          yield* db.create(`orders/${id}`, { ...order }).pipe(Effect.orDie);

          return yield* HttpServerResponse.json({ id }, { status: 201 });
        }

        return yield* HttpServerResponse.json(
          { error: "not found" },
          { status: 404 },
        );
      }),
    };
  }).pipe(Effect.provide(GCP.Firestore.WriteDatabaseHttp)),
) {}

import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Http from "alchemy/Http";
import * as Effect from "effect/Effect";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import * as HttpRouter from "effect/http/HttpRouter";
import * as Layer from "effect/Layer";
import { Order, OrderNotFound, OrdersApi, Product, ProductNotFound } from "./Api.ts";
import { Catalog, HOSTNAME, OrderBook } from "./Store.ts";

/** `/orders/*` — reads the catalog, reads and writes orders. */
export default class Orders extends Cloudflare.Worker<Orders>()(
  "Orders",
  {
    main: import.meta.url,
    routes: [{ pattern: `${HOSTNAME}/orders*` }],
  },
  Effect.gen(function* () {
    const catalog = yield* Cloudflare.KV.ReadNamespace(Catalog);
    const orders = yield* Cloudflare.KV.ReadWriteNamespace(OrderBook);

    return {
      fetch: yield* HttpRouter.toHttpEffect(
        HttpApiBuilder.layer(OrdersApi).pipe(
          Layer.provide(Http.Platform),
          Layer.provide(
            HttpApiBuilder.group(OrdersApi, "orders", (handlers) =>
              handlers
                .handle("create", ({ payload }) =>
                  Effect.gen(function* () {
                    const product = yield* catalog
                      .get<Product>(payload.productId, "json")
                      .pipe(Effect.orDie);
                    if (!product) {
                      return yield* new ProductNotFound({ id: payload.productId });
                    }
                    const order = new Order({
                      id: crypto.randomUUID(),
                      productId: product.id,
                      quantity: payload.quantity,
                      total: product.price * payload.quantity,
                    });
                    yield* orders.put(order.id, JSON.stringify(order)).pipe(Effect.orDie);
                    return order;
                  }),
                )
                .handle("get", ({ params }) =>
                  orders.get<Order>(params.id, "json").pipe(
                    Effect.orDie,
                    Effect.flatMap((order) =>
                      order
                        ? Effect.succeed(new Order(order))
                        : Effect.fail(new OrderNotFound({ id: params.id })),
                    ),
                  ),
                ),
            ),
          ),
        ),
      ),
    };
  }).pipe(
    Effect.provide(
      Layer.mergeAll(Cloudflare.KV.ReadNamespaceBinding, Cloudflare.KV.ReadWriteNamespaceBinding),
    ),
  ),
) {}

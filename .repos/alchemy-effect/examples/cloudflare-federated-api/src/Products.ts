import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Http from "alchemy/Http";
import * as Effect from "effect/Effect";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import * as HttpRouter from "effect/http/HttpRouter";
import * as Layer from "effect/Layer";
import { Product, ProductNotFound, ProductsApi } from "./Api.ts";
import { Catalog, HOSTNAME } from "./Store.ts";

/** `GET /products/*` — read-only access to the catalog. */
export default class Products extends Cloudflare.Worker<Products>()(
  "Products",
  {
    main: import.meta.url,
    routes: [{ pattern: `${HOSTNAME}/products*` }],
  },
  Effect.gen(function* () {
    const catalog = yield* Cloudflare.KV.ReadNamespace(Catalog);

    const get = (id: string) =>
      catalog.get<Product>(id, "json").pipe(
        Effect.orDie,
        Effect.flatMap((product) =>
          product ? Effect.succeed(new Product(product)) : Effect.fail(new ProductNotFound({ id })),
        ),
      );

    return {
      fetch: yield* HttpRouter.toHttpEffect(
        HttpApiBuilder.layer(ProductsApi).pipe(
          Layer.provide(Http.Platform),
          Layer.provide(
            HttpApiBuilder.group(ProductsApi, "products", (handlers) =>
              handlers
                .handle("list", () =>
                  catalog.list().pipe(
                    Effect.orDie,
                    Effect.flatMap(({ keys }) =>
                      Effect.forEach(keys, ({ name }) => get(name).pipe(Effect.orDie)),
                    ),
                  ),
                )
                .handle("get", ({ params }) => get(params.id)),
            ),
          ),
        ),
      ),
    };
  }).pipe(Effect.provide(Cloudflare.KV.ReadNamespaceBinding)),
) {}

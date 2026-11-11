import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Http from "alchemy/Http";
import * as Effect from "effect/Effect";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import * as HttpRouter from "effect/http/HttpRouter";
import * as Layer from "effect/Layer";
import { AdminApi, Product } from "./Api.ts";
import { Catalog, HOSTNAME } from "./Store.ts";

/** `/admin/*` — write-only access to the catalog. */
export default class Admin extends Cloudflare.Worker<Admin>()(
  "Admin",
  {
    main: import.meta.url,
    routes: [{ pattern: `${HOSTNAME}/admin/*` }],
  },
  Effect.gen(function* () {
    const catalog = yield* Cloudflare.KV.WriteNamespace(Catalog);

    return {
      fetch: yield* HttpRouter.toHttpEffect(
        HttpApiBuilder.layer(AdminApi).pipe(
          Layer.provide(Http.Platform),
          Layer.provide(
            HttpApiBuilder.group(AdminApi, "admin", (handlers) =>
              handlers.handle("putProduct", ({ params, payload }) =>
                Effect.gen(function* () {
                  const product = new Product({ id: params.id, ...payload });
                  yield* catalog.put(product.id, JSON.stringify(product)).pipe(Effect.orDie);
                  return product;
                }),
              ),
            ),
          ),
        ),
      ),
    };
  }).pipe(Effect.provide(Cloudflare.KV.WriteNamespaceBinding)),
) {}

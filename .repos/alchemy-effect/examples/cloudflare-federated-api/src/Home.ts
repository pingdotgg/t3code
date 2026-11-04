import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Effect from "effect/Effect";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import { HOSTNAME } from "./Store.ts";

/**
 * Owns the hostname as a custom domain (DNS record + certificate) and
 * answers every path no route claims. It binds nothing.
 */
export default class Home extends Cloudflare.Worker<Home>()(
  "Home",
  {
    main: import.meta.url,
    domain: HOSTNAME,
  },
  Effect.succeed({
    fetch: HttpServerResponse.json({
      endpoints: [
        "GET /products",
        "GET /products/:id",
        "POST /orders",
        "GET /orders/:id",
        "PUT /admin/products/:id",
      ],
    }),
  }),
) {}

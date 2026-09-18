import * as Cloudflare from "@/Cloudflare/index.ts";
import * as Effect from "effect/Effect";
import * as HttpMiddleware from "effect/unstable/http/HttpMiddleware";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

/**
 * Plain Cloudflare.Worker whose `fetch` is piped through
 * `HttpMiddleware.cors()`. Regression fixture for #175: preflight used
 * to work while GET responses omitted Access-Control-Allow-Origin
 * because the Worker adapter skipped Effect's pre-response handler queue
 * (fixed in #404).
 */
export default class CorsWorker extends Cloudflare.Worker<CorsWorker>()(
  "CorsWorker",
  {
    main: import.meta.url,
  },
  Effect.gen(function* () {
    return {
      fetch: HttpMiddleware.cors()(
        HttpServerResponse.json({ message: "world" }),
      ),
    };
  }),
) {}

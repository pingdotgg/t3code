import * as Cloudflare from "@/Cloudflare/index.ts";
import * as Effect from "effect/Effect";
import * as HttpServerError from "effect/unstable/http/HttpServerError";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

export const readyMarker = "http-server-worker-ready";

/**
 * Values that must never escape the Worker over the wire when a handler
 * fails. The test asserts none of them appear in the HTTP response.
 */
export const sensitiveContext = [
  "sk_live_alchemy_super_secret",
  "tenant-customer-42",
  "/srv/alchemy/private/customer-42.json",
  "10.42.0.17",
];

export default class HttpServerWorker extends Cloudflare.Worker<HttpServerWorker>()(
  "HttpServerWorker",
  {
    main: import.meta.url,
  },
  Effect.gen(function* () {
    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        if (request.url.startsWith("/missing")) {
          // A Respondable error escaping as a defect must keep its intended
          // response (404), not be flattened into a generic 500.
          return yield* Effect.die(
            new HttpServerError.RouteNotFound({ request }),
          );
        }
        if (request.url.startsWith("/boom")) {
          return yield* Effect.fail(
            new Error(
              `Sensitive handler context: ${sensitiveContext.join(" ")}`,
            ),
          ).pipe(Effect.orDie);
        }
        return HttpServerResponse.text(readyMarker);
      }),
    };
  }),
) {}

import * as GCP from "alchemy/GCP";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import Quotes from "./Quotes.ts";

/**
 * The public front door. It forwards `GET /quote` to the private
 * {@link Quotes} service.
 *
 * `GCP.Run.InvokeService(quotes)` does both halves of the wiring: at
 * deploy time it grants `roles/run.invoker` on the Quotes service (and
 * only that service) to the Gateway's runtime service account and binds
 * Quotes' URL into the Gateway; at runtime it mints a Google-signed ID
 * token for that URL from the metadata server and sends it as
 * `Authorization: Bearer`.
 */
export default class Gateway extends GCP.Function<Gateway>()(
  "Gateway",
  {
    main: import.meta.url,
    invokerIamDisabled: true,
  },
  Effect.gen(function* () {
    const quotes = yield* GCP.Run.InvokeService(Quotes);

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.originalUrl, "http://localhost");

        if (request.method === "GET" && url.pathname === "/") {
          return HttpServerResponse.text("ok");
        }

        if (request.method === "GET" && url.pathname === "/quote") {
          const response = yield* quotes.fetch(`/quote${url.search}`).pipe(
            // Treat an unreachable backend as a 502, not a crash.
            Effect.catchTag("GCP.Run.InvokeServiceError", (error) =>
              Effect.succeed({
                status: 502,
                text: Effect.succeed(JSON.stringify({ error: error.message })),
              }),
            ),
          );
          return HttpServerResponse.text(yield* response.text, {
            status: response.status,
            contentType: "application/json",
          });
        }

        return yield* HttpServerResponse.json(
          { error: "not found" },
          { status: 404 },
        );
      }),
    };
  }).pipe(Effect.provide(GCP.Run.InvokeServiceHttp)),
) {}

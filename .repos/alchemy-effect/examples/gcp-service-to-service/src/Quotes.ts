import * as GCP from "alchemy/GCP";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";

const QUOTES = [
  "Simplicity is prerequisite for reliability. — Edsger W. Dijkstra",
  "Make it work, make it right, make it fast. — Kent Beck",
  "Programs must be written for people to read. — Harold Abelson",
];

/**
 * A private backend. Without `invokerIamDisabled`, Cloud Run's front end
 * rejects every request that does not carry a Google-signed ID token
 * from a principal holding `roles/run.invoker` on this service — the
 * container never sees them.
 *
 * - `GET /quote` — a quote, picked by the optional `?n=` index.
 */
export default class Quotes extends GCP.Function<Quotes>()(
  "Quotes",
  {
    main: import.meta.url,
  },
  Effect.gen(function* () {
    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.originalUrl, "http://localhost");

        if (request.method === "GET" && url.pathname === "/quote") {
          const n = Number(url.searchParams.get("n") ?? "0");
          const index = Number.isInteger(n) && n >= 0 ? n % QUOTES.length : 0;
          return yield* HttpServerResponse.json({
            index,
            quote: QUOTES[index],
            servedBy: "quotes",
          });
        }

        return yield* HttpServerResponse.json(
          { error: "not found" },
          { status: 404 },
        );
      }),
    };
  }),
) {}

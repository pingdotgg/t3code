import * as Lambda from "@/AWS/Lambda";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import path from "pathe";

const main = path.resolve(import.meta.dirname, "http-handler.ts");

export class HttpApiTestFunction extends Lambda.Function<Lambda.Function>()(
  "HttpApiTestFunction",
) {}

/**
 * Fixture Lambda for the HTTP API e2e test. Payload format 2.0 events flow
 * through `makeFunctionHttpHandler`'s Function-URL path unchanged, so a
 * plain Effect `fetch` handler serves the API. One route per behavior:
 *
 * - `GET /echo?..`     → method, path, and query string round-trip
 * - `GET /items/{id}`  → path parameter routing
 * - `POST /items`      → JSON body round-trip
 * - anything else      → 404 with the observed method/path
 */
export default HttpApiTestFunction.make(
  {
    main,
    timeout: Duration.seconds(30),
  },
  Effect.gen(function* () {
    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.originalUrl);
        const pathname = url.pathname;

        if (request.method === "GET" && pathname === "/echo") {
          return yield* HttpServerResponse.json({
            method: request.method,
            path: pathname,
            query: Object.fromEntries(url.searchParams.entries()),
          });
        }

        const itemMatch = pathname.match(/^\/items\/([^/]+)$/);
        if (request.method === "GET" && itemMatch) {
          return yield* HttpServerResponse.json({ id: itemMatch[1] });
        }

        if (request.method === "POST" && pathname === "/items") {
          const body = (yield* request.json) as unknown;
          return yield* HttpServerResponse.json(
            { received: body },
            { status: 201 },
          );
        }

        return yield* HttpServerResponse.json(
          { error: "Not found", method: request.method, path: pathname },
          { status: 404 },
        );
      }).pipe(Effect.orDie),
    };
  }),
);

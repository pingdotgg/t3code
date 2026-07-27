import * as Cloudflare from "@/Cloudflare";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import RpcCounterObject from "./object.ts";

/**
 * Plain {@link Cloudflare.Worker} that drives the
 * {@link RpcCounterObject} via the typed `getByName(id)` client returned
 * from {@link Cloudflare.RpcDurableObject}. Each route maps to
 * one RPC, so the integ test can assert the round-trip end to end:
 *
 * - `POST /counter/:id/increment` → `Increment`
 * - `GET  /counter/:id`           → `Get`
 * - `GET  /counter/:id/stream?upto=N` → `CountUpTo` (newline-delimited)
 */
export default class RpcCounterWorker extends Cloudflare.Worker<RpcCounterWorker>()(
  "RpcCounterWorker",
  {
    main: import.meta.url,
  },
  Effect.gen(function* () {
    const counters = yield* RpcCounterObject;

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://x");
        const match = url.pathname.match(/^\/counter\/([^/]+)(?:\/(\w+))?$/);
        if (!match)
          return HttpServerResponse.text("Not Found", { status: 404 });
        const [, id, action] = match;

        if (request.method === "POST" && action === "increment") {
          const client = yield* counters.getByName(id);
          const result = yield* client.Increment({}).pipe(Effect.orDie);
          return yield* HttpServerResponse.json(result);
        }
        if (request.method === "POST" && action === "reset") {
          const client = yield* counters.getByName(id);
          yield* client.Reset({}).pipe(Effect.orDie);
          return HttpServerResponse.text("ok");
        }
        if (request.method === "GET" && action === "stream") {
          const upto = Number(url.searchParams.get("upto") ?? "5");
          const body = Stream.unwrap(
            Effect.map(counters.getByName(id), (client) =>
              client.CountUpTo({ upto }).pipe(
                Stream.map((n) => new TextEncoder().encode(`${n}\n`)),
                Stream.orDie,
              ),
            ),
          );
          return HttpServerResponse.stream(body, {
            headers: { "content-type": "text/plain" },
          });
        }
        if (request.method === "GET" && action === undefined) {
          const client = yield* counters.getByName(id);
          const result = yield* client.Get({}).pipe(Effect.orDie);
          return yield* HttpServerResponse.json(result);
        }
        return HttpServerResponse.text("Not Found", { status: 404 });
      }),
    };
  }),
) {}

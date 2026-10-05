import * as Cloudflare from "@/Cloudflare/index.ts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import { SocketObject, SocketObjectLive } from "./object.ts";

export default class SocketWorker extends Cloudflare.Worker<SocketWorker>()(
  "SocketWorker",
  { main: import.meta.url },
  Effect.gen(function* () {
    const objects = yield* SocketObject;
    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const [, action, name = "default", key = "default"] = new URL(
          request.url,
          "http://localhost",
        ).pathname.split("/");
        if (action === "not-found" || action === "server-error") {
          return HttpServerResponse.text("application error", {
            status: action === "not-found" ? 404 : 500,
          });
        }
        if (action === "rpc") {
          return yield* objects.fetch(name, request);
        }
        if (action === "release" && request.method === "POST") {
          const client = yield* objects.getByName(name);
          return yield* HttpServerResponse.json({
            released: yield* client.releaseCleanup({ key }).pipe(Effect.orDie),
          });
        }
        if (action === "serialization" && request.method === "POST") {
          const client = yield* objects.getByName(name);
          return yield* HttpServerResponse.json({
            changed: yield* client
              .invalidateSocketSerialization()
              .pipe(Effect.orDie),
          });
        }
        if (action === "abort" && request.method === "POST") {
          const client = yield* objects.getByName(name);
          return yield* client.abort().pipe(
            Effect.matchCause({
              onFailure: () => HttpServerResponse.json({ aborted: true }),
              onSuccess: () =>
                HttpServerResponse.json({ aborted: false }, { status: 500 }),
            }),
            Effect.flatten,
          );
        }
        if (action === "stats") {
          const client = yield* objects.getByName(name);
          return yield* HttpServerResponse.json(
            yield* client.stats().pipe(Effect.orDie),
          );
        }
        return HttpServerResponse.text("ready");
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.succeed(
            HttpServerResponse.text(Cause.pretty(cause), { status: 500 }),
          ),
        ),
      ),
    };
  }).pipe(Effect.provide(SocketObjectLive)),
) {}

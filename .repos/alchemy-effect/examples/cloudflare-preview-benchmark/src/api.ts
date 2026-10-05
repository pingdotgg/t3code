import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import { Photos, Sessions } from "./resources.ts";

export default Cloudflare.Worker(
  "Api",
  { main: import.meta.url },
  Effect.gen(function* () {
    const photos = yield* Cloudflare.R2.ReadWriteBucket(Photos);
    const sessions = yield* Cloudflare.KV.ReadWriteNamespace(Sessions);

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const path = new URL(request.url, "http://localhost").pathname;

        // GET /photos — the gallery: every object key in Photos
        if (path === "/photos" && request.method === "GET") {
          const list = yield* photos.list();
          return yield* HttpServerResponse.json({
            photos: list.objects.map((object) => object.key),
          });
        }

        // PUT /photos/:key — upload the request body to Photos
        if (path.startsWith("/photos/") && request.method === "PUT") {
          const key = path.slice("/photos/".length);
          yield* photos.put(key, request.stream, {
            contentLength: Number(request.headers["content-length"] ?? 0),
          });
          return HttpServerResponse.empty({ status: 201 });
        }

        // GET /session — with `x-session-id`, read the session back from
        // Sessions; without it, start a new session and store it
        if (path === "/session" && request.method === "GET") {
          const id = request.headers["x-session-id"];
          if (id) {
            const value = yield* sessions.get(`session:${id}`);
            return yield* HttpServerResponse.json({ id, value });
          }
          const newId = yield* Effect.sync(() => crypto.randomUUID());
          yield* sessions.put(`session:${newId}`, newId);
          return yield* HttpServerResponse.json({ id: newId, value: newId });
        }

        return HttpServerResponse.text("Not found", { status: 404 });
      }).pipe(
        Effect.catchTag(["R2Error", "NamespaceError"], (error) =>
          Effect.succeed(
            HttpServerResponse.text(error.message, { status: 500 }),
          ),
        ),
      ),
    };
  }).pipe(
    Effect.provide(Cloudflare.R2.ReadWriteBucketBinding),
    Effect.provide(Cloudflare.KV.ReadWriteNamespaceBinding),
  ),
);

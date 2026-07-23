import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

export const Bucket = Cloudflare.R2Bucket("Bucket");

export default class Backend extends Cloudflare.Worker<Backend>()(
  "Backend",
  {
    main: import.meta.path,
  },
  Effect.gen(function* () {
    const bucket = yield* Cloudflare.R2Bucket.bind(Bucket);

    return {
      // RPC method — read an object from R2 by key, returning the body as
      // text or `null` if the key is missing. Other workers can call this
      // directly via the service binding (option 3 in `api.hello.ts`).
      hello: Effect.fn("Backend.hello")(function* (key: string) {
        const object = yield* bucket.get(key);
        if (object === null) return null;
        return yield* object.text();
      }),

      // HTTP handler — supports `GET` and `PUT` against R2 by `?key=...`.
      // Other workers can call this via `env.BACKEND.fetch(...)` (option 2
      // in `api.hello.ts`).
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const key = new URL(request.url, "http://backend").searchParams.get(
          "key",
        );
        if (!key) {
          return HttpServerResponse.text("Missing 'key' query parameter", {
            status: 400,
          });
        }

        if (request.method === "GET") {
          const object = yield* bucket.get(key);
          if (object === null) {
            return HttpServerResponse.text("Not found", { status: 404 });
          }
          return HttpServerResponse.stream(object.body);
        }

        if (request.method === "PUT") {
          yield* bucket.put(key, request.stream, {
            contentLength: Number(request.headers["content-length"] ?? 0),
          });
          return HttpServerResponse.empty({ status: 204 });
        }

        return HttpServerResponse.text("Method not allowed", { status: 405 });
      }).pipe(
        Effect.catchTag("R2Error", (error) =>
          Effect.succeed(
            HttpServerResponse.text(error.message, { status: 500 }),
          ),
        ),
      ),
    };
  }).pipe(Effect.provide(Cloudflare.R2BucketBindingLive)),
) {}

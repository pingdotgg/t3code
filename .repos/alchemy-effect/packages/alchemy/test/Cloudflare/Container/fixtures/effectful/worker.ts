import * as Cloudflare from "@/Cloudflare";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { Object } from "./object.ts";

export default Cloudflare.Worker(
  "Worker",
  {
    main: import.meta.url,
  },
  Effect.gen(function* () {
    const objects = yield* Object;

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://x");

        const object = objects.getByName("default");

        // Plain RPC into the container (no bucket).
        if (url.pathname === "/ping") {
          const pong = yield* object.ping();
          return HttpServerResponse.text(pong);
        }

        // Seed R2 through the DO's native binding.
        if (request.method === "PUT" && url.pathname === "/seed") {
          const key = url.searchParams.get("key") ?? "";
          const value = yield* request.text;
          yield* object.put(key, value).pipe(Effect.orDie);
          return yield* HttpServerResponse.json({ ok: true });
        }

        // Bucket read end-to-end through the container over RPC.
        if (url.pathname === "/rpc") {
          const key = url.searchParams.get("key") ?? "";
          const value = yield* object.readObjectRpc(key).pipe(Effect.orDie);
          return yield* HttpServerResponse.json({ value });
        }

        // Bucket read end-to-end through the container over fetch (TCP port).
        if (url.pathname === "/fetch") {
          const key = url.searchParams.get("key") ?? "";
          const result = yield* object.readObjectFetch(key);
          return yield* HttpServerResponse.json(result);
        }

        if (url.pathname === "/hello") {
          const text = yield* object.hello().pipe(Effect.orDie);
          return HttpServerResponse.text(text);
        }

        return HttpServerResponse.text("ok");
      }),
    };
  }),
);

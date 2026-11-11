import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import { Object } from "./object.ts";

// Report failures in the response body, so a test that times out waiting
// for the container shows why instead of a bare 500.
const reportFailure = Effect.catchCause((cause: Cause.Cause<unknown>) =>
  Effect.succeed(HttpServerResponse.text(Cause.pretty(cause), { status: 500 })),
);

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
          const pong = yield* object.ping().pipe(Effect.orDie);
          return HttpServerResponse.text(pong);
        }

        // The env var a `Binding.Service` bound onto the container.
        if (url.pathname === "/bound-env") {
          const value = yield* object.boundEnv().pipe(Effect.orDie);
          return yield* HttpServerResponse.json({ value: value ?? null });
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
      }).pipe(reportFailure),
    };
  }),
);

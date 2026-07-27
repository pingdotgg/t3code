import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

/**
 * The effectful MicroVM server, shared verbatim by the bun and node effectful
 * images so the only thing that differs between them is the JS runtime. Exposes
 * a raw `fetch` handler (with an `/echo` route) and a typed RPC `hello` method.
 */
export const effectfulImpl = Effect.gen(function* () {
  return {
    fetch: Effect.gen(function* () {
      const request = yield* HttpServerRequest;
      const url = new URL(request.url, "http://microvm");
      if (url.pathname === "/echo") {
        return yield* HttpServerResponse.json({
          message: url.searchParams.get("message") ?? "",
        });
      }
      return HttpServerResponse.text("hello from effectful microvm");
    }),
    hello: (message: string) => Effect.succeed(`hello, ${message}!`),
  };
});

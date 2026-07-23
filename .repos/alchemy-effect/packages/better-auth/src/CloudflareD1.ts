import { Random } from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import { betterAuth as makeBetterAuth } from "better-auth";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { BetterAuth } from "./BetterAuth.ts";

export const CloudflareD1 = Layer.effect(
  BetterAuth,
  Effect.gen(function* () {
    const d1 = yield* Cloudflare.D1Database("BetterAuth");

    const connection = yield* Cloudflare.D1Connection.bind(d1);

    const BETTER_AUTH_SECRET = yield* Random("BETTER_AUTH_SECRET");

    const betterAuthSecret = yield* BETTER_AUTH_SECRET.text;

    const betterAuth = yield* Effect.gen(function* () {
      return makeBetterAuth({
        database: yield* connection.raw,
        secret: yield* betterAuthSecret.pipe(Effect.map(Redacted.value)),
      });
    }).pipe(Effect.cached);

    return {
      auth: betterAuth,
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const auth = yield* betterAuth;

        const response = yield* Effect.promise(() =>
          auth.handler(request.source as Request),
        );
        return HttpServerResponse.fromWeb(response);
      }),
    };
  }),
).pipe(Layer.provide(Cloudflare.D1ConnectionLive));

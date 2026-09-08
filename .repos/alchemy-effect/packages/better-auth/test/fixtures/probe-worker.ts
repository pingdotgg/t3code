/**
 * Compile-time probe: `yield* BetterAuth({...})` composes inside a
 * `Cloudflare.Worker` impl when the Database layer is provided on the
 * effect. This pins the requirement-erasure design — if the Worker's `Req`
 * constraint ever rejects the shape, this file breaks the type-check.
 */
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { BetterAuth, Memory } from "../../src/index.ts";

export default class ProbeWorker extends Cloudflare.Worker<ProbeWorker>()(
  "ProbeWorker",
  {
    main: import.meta.url,
  },
  Effect.gen(function* () {
    const auth = yield* BetterAuth({
      basePath: "/auth",
      emailAndPassword: { enabled: true },
    });

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        if (request.url.startsWith("/auth")) {
          return yield* auth.fetch;
        }
        const session = yield* auth
          .getSession()
          .pipe(Effect.catch((error) => Effect.succeed(null)));
        return yield* HttpServerResponse.json({
          signedIn: session !== null,
        });
      }),
    };
  }).pipe(Effect.provide(Memory())),
) {}

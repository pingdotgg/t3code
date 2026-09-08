import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { CloudflareD1 } from "../../../src/CloudflareD1.ts";
import { BetterAuth } from "../../../src/index.ts";

export const Db = Cloudflare.D1.Database("BetterAuthDb");

export default class AuthWorker extends Cloudflare.Worker<AuthWorker>()(
  "BetterAuthD1Worker",
  {
    main: import.meta.url,
    compatibility: {
      date: "2026-03-17",
      flags: ["nodejs_compat"],
    },
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
        if (request.url.startsWith("/me")) {
          const session = yield* auth
            .getSession()
            .pipe(
              Effect.catchTag("BetterAuthApiError", () => Effect.succeed(null)),
            );
          return yield* HttpServerResponse.json({
            email: session?.user.email ?? null,
          });
        }
        return HttpServerResponse.text("ok");
      }),
    };
  }).pipe(Effect.provide(CloudflareD1(Db))),
) {}

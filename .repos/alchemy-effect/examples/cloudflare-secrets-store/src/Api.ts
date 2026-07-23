import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { ApiKey } from "./ApiKey.ts";

export default class Api extends Cloudflare.Worker<Api>()(
  "Api",
  {
    main: import.meta.filename,
  },
  Effect.gen(function* () {
    const apiKey = yield* Cloudflare.Secret.bind(ApiKey);

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;

        if (request.url === "/secret") {
          const value = Redacted.value(yield* apiKey);
          const masked = value.slice(0, 4) + "****";
          return HttpServerResponse.text(`Secret (masked): ${masked}`);
        }

        return HttpServerResponse.text(
          "Hello from Cloudflare Secrets Store example!",
        );
      }).pipe(
        Effect.catchTag("SecretError", (err) =>
          Effect.succeed(
            HttpServerResponse.text(`Failed to read secret: ${err.message}`, {
              status: 500,
            }),
          ),
        ),
      ),
    };
  }).pipe(Effect.provide(Cloudflare.SecretBindingLive)),
) {}

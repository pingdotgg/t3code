import * as Cloudflare from "@/Cloudflare";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { ApiKey } from "./secret.ts";
import { secretRoutes } from "./secret-routes.ts";

/**
 * Effect-native invocation style: the Secret is bound inside the Worker init
 * via `Cloudflare.SecretsStore.ReadSecret(ApiKey)` and the binding layer is
 * provided with `Effect.provide(ReadSecretBinding)`. The `/secret` route drives
 * the resulting {@link ReadSecretClient} (direct Effect, `.get()`, `.raw`).
 */
export default class EffectSecretWorker extends Cloudflare.Worker<EffectSecretWorker>()(
  "EffectSecretBindingWorker",
  {
    main: import.meta.url,
    subdomain: { enabled: true, previewsEnabled: false },
  },
  Effect.gen(function* () {
    const secret = yield* ApiKey;
    const apiKey = yield* Cloudflare.SecretsStore.ReadSecret(secret);
    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.originalUrl, "http://x");
        const handled = yield* secretRoutes(apiKey, url);
        return handled ?? HttpServerResponse.text("Not Found", { status: 404 });
      }),
    };
  }).pipe(Effect.provide(Cloudflare.SecretsStore.ReadSecretBinding)),
) {}

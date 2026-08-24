import * as Cloudflare from "@/Cloudflare";
import type * as runtime from "@cloudflare/workers-types";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { ApiKey } from "./secret.ts";

/**
 * Async-binding invocation style: the `Cloudflare.SecretsStore.Secret` is
 * declared directly on the Worker's `env` (resolved through the service's
 * async-binding predicate) rather than via `ReadSecret`. The Worker provider
 * must map it to a `secrets_store_secret` binding so the runtime sees a real
 * `SecretsStoreSecret` (with `.get()`), not a JSON blob. The `/secret` route
 * reads it back over the raw runtime binding and echoes the value in the same
 * shape as the effect-worker route so one driver covers both styles.
 */
export default class AsyncSecretWorker extends Cloudflare.Worker<AsyncSecretWorker>()(
  "AsyncSecretBindingWorker",
  {
    main: import.meta.url,
    subdomain: { enabled: true, previewsEnabled: false },
    env: {
      MY_SECRET: ApiKey,
    },
  },
  Effect.gen(function* () {
    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const pathname = new URL(request.originalUrl, "http://x").pathname;
        if (pathname === "/secret") {
          const env = yield* Cloudflare.Workers.WorkerEnvironment;
          const secret = (env as Record<string, runtime.SecretsStoreSecret>)
            .MY_SECRET;
          const value = yield* Effect.promise(() => secret.get());
          return yield* HttpServerResponse.json({
            value,
            viaGet: value,
            viaRaw: value,
          });
        }
        return HttpServerResponse.text("Not Found", { status: 404 });
      }),
    };
  }),
) {}

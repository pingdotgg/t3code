import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { App } from "./app.ts";

/**
 * Effect-native Worker fixture for the Cloudflare Flagship binding.
 * `Flagship.ReadFlags(App)` during init attaches the binding to this Worker
 * (registering the app resource with the stack) and resolves to the runtime
 * client.
 */
export default class FlagshipEffectWorker extends Cloudflare.Worker<FlagshipEffectWorker>()(
  "FlagshipEffectWorker",
  {
    main: import.meta.url,
  },
  Effect.gen(function* () {
    const flags = yield* Cloudflare.Flagship.ReadFlags(App);

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;

        if (request.url.startsWith("/bool")) {
          const enabled = yield* flags
            .getBooleanValue("test-flag", false, { userId: "user-42" })
            .pipe(Effect.orDie);
          return yield* HttpServerResponse.json({ mode: "effect", enabled });
        }

        if (request.url.startsWith("/details")) {
          const details = yield* flags
            .getStringDetails("nonexistent-flag", "fallback", {
              userId: "user-42",
            })
            .pipe(Effect.orDie);
          return yield* HttpServerResponse.json({ mode: "effect", details });
        }

        return HttpServerResponse.text("ok");
      }),
    };
  }).pipe(Effect.provide(Cloudflare.Flagship.ReadFlagsBinding)),
) {}

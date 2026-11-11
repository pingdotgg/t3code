import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import { lookupConfigName } from "./lookup.ts";
import { connectionRoutes } from "./routes.ts";

/**
 * An existing Hyperdrive configuration looked up by name — never managed by
 * the stack.
 */
export const LookupHyperdrive = Cloudflare.Hyperdrive.lookup("HyperdriveLookup", {
  name: lookupConfigName("live"),
});

/**
 * Effect-native Worker binding the looked-up configuration through
 * `Cloudflare.Hyperdrive.Connect` and exposing the client over the shared
 * {@link connectionRoutes}.
 */
export default class HyperdriveLookupEffectWorker extends Cloudflare.Worker<HyperdriveLookupEffectWorker>()(
  "HyperdriveLookupEffectWorker",
  { main: import.meta.url },
  Effect.gen(function* () {
    const hd = yield* Cloudflare.Hyperdrive.Connect(LookupHyperdrive);
    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://x");
        const handled = yield* connectionRoutes(hd, url);
        return handled ?? HttpServerResponse.text("Not Found", { status: 404 });
      }),
    };
  }).pipe(Effect.provide(Cloudflare.Hyperdrive.ConnectBinding)),
) {}

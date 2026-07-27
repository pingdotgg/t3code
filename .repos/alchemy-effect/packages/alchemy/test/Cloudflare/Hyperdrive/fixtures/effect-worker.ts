import * as Cloudflare from "@/Cloudflare/index.ts";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { HyperdriveConnection } from "./connection.ts";
import { connectionRoutes } from "./routes.ts";

/**
 * Effect-native Worker that binds the shared Hyperdrive Connection via
 * `Cloudflare.Hyperdrive.Connect(connection)` and exposes the client over
 * `fetch` through the shared {@link connectionRoutes}. The binding is
 * provided via `Effect.provide(Cloudflare.Hyperdrive.ConnectBinding)`.
 */
export default class HyperdriveEffectWorker extends Cloudflare.Worker<HyperdriveEffectWorker>()(
  "HyperdriveEffectWorker",
  { main: import.meta.url },
  Effect.gen(function* () {
    const { connection } = yield* HyperdriveConnection;
    const hd = yield* Cloudflare.Hyperdrive.Connect(connection);
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

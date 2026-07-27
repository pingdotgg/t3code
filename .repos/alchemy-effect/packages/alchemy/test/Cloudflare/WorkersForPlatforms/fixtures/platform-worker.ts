import * as Cloudflare from "@/Cloudflare/index.ts";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { DispatchNs } from "./shared.ts";

/**
 * Effect-native platform Worker that binds the dispatch namespace via
 * `Cloudflare.WorkersForPlatforms.Get(DispatchNs)` and forwards requests to a
 * user Worker by script name.
 *
 * `GET /dispatch/:scriptName/...` looks up `:scriptName` in the namespace and
 * forwards the trailing path (plus the `x-custom` header) to the user Worker's
 * `Fetcher`, returning its response verbatim.
 */
export default class WfpPlatformWorker extends Cloudflare.Worker<WfpPlatformWorker>()(
  "WfpBindingPlatformWorker",
  { main: import.meta.filename, url: true },
  Effect.gen(function* () {
    const dispatch = yield* Cloudflare.WorkersForPlatforms.Get(DispatchNs);

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://placeholder");
        const match = url.pathname.match(/^\/dispatch\/([^/]+)(\/.*)?$/);
        if (!match) {
          return HttpServerResponse.text("platform-worker ok");
        }
        const [, scriptName, rest] = match;
        const userWorker = yield* dispatch.get(scriptName).pipe(Effect.orDie);
        const response = yield* Effect.promise(() =>
          userWorker.fetch(
            new Request(`https://user-worker${rest ?? "/"}`, {
              headers: { "x-custom": request.headers["x-custom"] ?? "" },
            }),
          ),
        );
        return HttpServerResponse.fromWeb(response);
      }),
    };
  }).pipe(Effect.provide(Cloudflare.WorkersForPlatforms.GetBinding)),
) {}
